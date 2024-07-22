import { sleep } from "bun";

/**
 * States for a job to be in.
 */
export type ComfyJob_Status = "building" | "queued" | "running" | "completed" | "failed" | "cancelled"

/**
 * Possible resource types in ComfyUI
 */
export type ComfyResType = 'input' | 'output' | 'temp'  //TODO: check if this is correct and exhaustive.

/**
 * A job instance to be deployed on a comfyui server.
 */
export class ComfyJob {
    #parent?: ComfyClient
    #uid?: string
    #status: ComfyJob_Status = "building"
    #onCompleted?: (obj: ComfyJob) => void | Promise<void>
    #onCancelled?: (obj: ComfyJob) => void | Promise<void>
    #onUpdate?: (obj: ComfyJob, node: number) => void | Promise<void>
    #onError?: (obj: ComfyJob, errors: unknown) => void | Promise<void>
    #workflow: unknown
    #errors: unknown;

    /**
     * The unique id of this job. Undefined if not queued yet.
     */
    get uid() { return this.#uid }
    /**
     * The target client. Undefined if not queued yet.
     */
    get parent() { return this.#parent }
    get status() { return this.#status }
    get errors() { return this.#errors }

    /**
     * Build a new job object detached from any specific client.
     * @param wk final json of the promt to send to the backend.
     */
    constructor(wk: unknown) {
        this.#workflow = wk
    }

    /**
     * Use the current json to generate a new promt.
     * @returns A copy of the current workflow, ready to be queued.
     */
    clone() {
        const tmp = new ComfyJob({})
        tmp.#workflow = this.#workflow
        return tmp;
    }

    /**
     * 
     * @param parent The client onto which this job will be queued.
     * @param callbacks Callbacks for each supported event during any job's lifecycle.
     * @param callbacks.onCompleted Run right after a job is set for completion.
     * @param callbacks.onCancelled Run right after a job is determined to be cancelled.'
     * @param callbacks.onError Run right after an error is detected within a job execution.
     * @param callbacks.onUpdate Run right after a partial result from a job is gathered.
     * @returns this object.
     */
    async queue(parent: ComfyClient, callbacks: {
        onCompleted?: (obj: ComfyJob) => void | Promise<void>,
        onCancelled?: (obj: ComfyJob) => void | Promise<void>,
        onUpdate?: (obj: ComfyJob, node: number) => void | Promise<void>,
        onError?: (obj: ComfyJob, errors: unknown) => void | Promise<void>
    }) {
        if (this.#status !== 'building') throw Error('Cannot place a ComfyJob on queue twice. Consider cloning.')
        this.#parent = parent
        this.#onCompleted = callbacks.onCompleted
        this.#onUpdate = callbacks.onUpdate
        this.#onError = callbacks.onError


        const tmp = await this.#parent.post_prompt(this.#workflow)
        this.#status = 'queued'
        this.#uid = tmp.prompt_id
        if (Object.keys(tmp.node_errors).length !== 0) {
            this.#status = 'failed'
            if (this.#onError) await this.#onError(this, tmp.errors);
        }
        this.#parent.registerExecutingCallback(this, {
            onCompleted: async (job) => {
                this.#status = "completed";
                this.#parent!.unregisterExecutingCallback(this);
                if (callbacks.onCompleted) await callbacks.onCompleted(job);
            },
            onUpdate: async (job, node) => {
                this.#status = "running";
                if (callbacks.onUpdate) await callbacks.onUpdate(job, node);
            },
            onError: async (job, errors) => {
                this.#status = "failed";
                this.#parent!.unregisterExecutingCallback(this);
                if (callbacks.onError) await callbacks.onError(job, errors);
            },
            onCancelled: async (job) => {
                this.#status = "cancelled";
                if (callbacks.onCancelled) await callbacks.onCancelled(job);
            },
        }
        )

        return this;
    }

    //TODO
    //To await completion, collect the result and do something with it.
    async completion() {
        while (true) {
            if (this.#status === 'running') sleep(0)
            else break;
        }
    }

    /**
     * Cancel this job, regardless of its current progression.
     */
    async cancel() {
        if (['cancelled', 'failed', 'completed', 'building'].includes(this.#status)) return;    //Ignore deletion for these cases
        const tmp = await this.#parent!.delete_queue_entries([this.#uid!])
    }
}

/**
 * A comfyui client, exposing all its REST endpoints.
 */
export class ComfyClient {
    #endpoint: string;
    #secure: boolean;
    #socket: WebSocket;
    #uid = crypto.randomUUID();
    #running = false;
    #debug = false;

    #jobs: Map<string, { job: ComfyJob, onCompleted: (obj: ComfyJob) => void | Promise<void>, onCancelled: (obj: ComfyJob) => void | Promise<void>, onUpdate: (obj: ComfyJob, node: number) => void | Promise<void>, onError: (obj: ComfyJob, errors: unknown) => void | Promise<void> }>

    get running() { return this.#running }
    get uid() { return this.#uid }

    /**
     * 
     * @param endpoint The location of the endpoint.
     * @param param1.debug If true it shows additional debugging output.
     * @param param1.secure If true it use https and wss in place of the not encrypted versions.
     */
    constructor(endpoint: string, {
        debug = false,
        secure = false,
    }) {
        this.#debug = debug
        this.#secure = secure
        this.#endpoint = endpoint
        this.#socket = new WebSocket(`ws${this.#secure ? 's' : ''}://${this.#endpoint}/ws?${new URLSearchParams({
            clientId: this.#uid,
        }).toString()}`);
        this.#jobs = new Map()

        // message is received
        this.#socket.addEventListener("message", async (event) => {
            if (event.type === "message") {
                const data = JSON.parse(event.data);
                if (data.type === "status") {
                    console.log('Status')
                    console.log(data.data);
                } else if (data.type === "executing") {
                    console.log('Executing')
                    //Last execution for the prompt
                    const t = this.#jobs.get(data.data.prompt_id)
                    if (data.data.node === null && t) {
                        await t.onCompleted(t.job)
                    }
                    console.log(data.data);
                } else if (data.type === "crystools.monitor") {
                    //TODO: Ignore for now, based on an external extension
                }
            }
        });

        // socket opened
        this.#socket.addEventListener("open", event => {
            if (this.#debug)
                console.log(
                    `Connection at ${this.#endpoint} started with identity ${this.#uid}`,
                );
            this.#running = true;
        });

        // socket closed
        this.#socket.addEventListener("close", event => {
            if (this.#debug)
                console.log('Connection with the comfyui backend closed');
            this.#running = false;
        });

        // error handler
        this.#socket.addEventListener("error", event => {
            if (this.#debug)
                console.error('Error in the comfyui backend', event);
            this.#running = false;
        });
    }

    /**
     * Manually closes the current connection. Usually not needed if the client is defined with the keyword `using`.
     */
    close() {
        this.#socket.close()
        this.#running = false;
    }

    //Destructor
    [Symbol.dispose] = () => this.close()

    registerExecutingCallback(job: ComfyJob, cb: { onCompleted: (obj: ComfyJob) => void | Promise<void>, onCancelled: (obj: ComfyJob) => void | Promise<void>, onUpdate: (obj: ComfyJob, node: number) => void | Promise<void>, onError: (obj: ComfyJob, errors: unknown) => void | Promise<void> }) {
        this.#jobs.set(job.uid!, { job, ...cb })
    }

    unregisterExecutingCallback(job: ComfyJob) {
        this.#jobs.delete(job.uid!)
    }

    /**
     * @returns System stats from ComfyUI
     */
    async system_stats() {
        return await (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/system_stats?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        ).json()
    }

    /**
     * @returns Available embeddings from ComfyUI
     */
    async embeddings() {
        return await (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/embeddings?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        ).json()
    }

    /**
     * @returns Listing all extensions installed on a ComfyUI instance
     */
    async extensions() {
        return await (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/extensions?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        ).json()
    }

    /**
     * 
     * @param content 
     * @param opts.overwrite 
     * @param opts.subfolder 
     * @param opts.type 
     * @returns 
     */
    async upload_image(content: Blob,
        opts: {
            overwrite?: boolean,
            subfolder?: string,
            type?: ComfyResType
        } = {}) {
        const form = new FormData()
        if (opts.overwrite === true) form.set("overwrite", "true");
        form.set('image', content, content.name)
        form.set('subfolder', opts.subfolder ?? '')
        form.set('type', opts.type ?? 'input')
        const tmp =
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/upload/image?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: 'POST', body: form }
            )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async upload_mask(content: Blob,
        opts: {
            overwrite?: boolean,
            subfolder?: string,
            type?: ComfyResType
            original_ref?: string
        } = {}) {
        const form = new FormData()
        if (opts.overwrite === true) form.set("overwrite", "true");
        form.set('image', content, content.name)
        form.set('subfolder', opts.subfolder ?? '')
        if (opts.original_ref !== undefined) form.set('original_ref', opts.original_ref)
        form.set('type', opts.type ?? 'input')
        const tmp =
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/upload/mask?clientId=${this.#uid}`,
                { method: 'POST', body: form }
            )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async view(filename: string, opts: { subfolder?: string, channel?: 'rgba' | 'rgb' | 'a', format?: 'jpg' | 'png' | 'webp', quality?: number } = {}) {
        const tmp =
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/view?${new URLSearchParams({
                    clientId: this.#uid,
                    filename: filename,
                    ...opts.subfolder ? { subfolder: opts.subfolder } : {},
                    ...opts.format ? {
                        preview: `${opts.format}${opts.quality ? `;${opts.quality}` : ''}`
                    } : {},
                    ...opts.channel ? { channel: opts.channel } : {}
                }).toString()}`,
                { method: "GET" },
            )
        if (tmp.ok) {
            return await tmp.blob();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async view_metadata(folder: string, filename: string) {
        const tmp =
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/view_metadata/${folder}?${new URLSearchParams({
                    clientId: this.#uid,
                    filename: filename
                }).toString()}`,
                { method: "GET" },
            )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async object_info(subclass?: string) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/object_info${subclass ? `/${subclass}` : ''}?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async interrupt() {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/interrupt?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST" },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async free(opts: { unload_models?: boolean, free_memory?: boolean }) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/free?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify(opts) },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    //HISTORY

    async get_history(id?: string) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/history${id ? `/${id}` : ''}?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async clear_history() {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/history?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify({ clear: true }) },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async delete_history_entries(entries: string[]) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/history?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify({ delete: entries }) },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    //QUEUE

    async get_queue() {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/queue?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async clear_queue() {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/queue?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify({ clear: true }) },
            )
        )
        if (tmp.ok) {
            for (const [key, value] of this.#jobs) {
                //Make sure all current jobs are going to error out if not completed already
                await value.onError(value.job, [])
            }
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async delete_queue_entries(entries: string[]) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/queue?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify({ delete: entries }) },
            )
        )
        if (tmp.ok) {
            for (const [key, value] of this.#jobs) {
                //Make sure all current jobs filtered are going to error out if not completed already
                if (entries.includes(key)) await value.onError(value.job, []);
            }
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    // PROMPT

    async get_prompt() {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/prompt?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "GET" },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }

    async post_prompt(workflow: unknown) {
        const tmp = (
            await fetch(
                `http${this.#secure ? "s" : ""}://${this.#endpoint}/prompt?${new URLSearchParams({
                    clientId: this.#uid,
                }).toString()}`,
                { method: "POST", body: JSON.stringify(workflow) },
            )
        )
        if (tmp.ok) {
            return await tmp.json();
        }

        throw Error(tmp.statusText, { cause: tmp.status })
    }


    new_job(workflow: unknown, cfg: Record<string, unknown>) { }

}

