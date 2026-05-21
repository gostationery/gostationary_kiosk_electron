class Linear16Player extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Int16Array(0);
        this.lastLogTime = 0;

        this.port.onmessage = (event) => {
            if (!event.data) return;

            // Stop command
            if (event.data.command === "stop") {
                this.buffer = new Int16Array(0);
                return;
            }

            // Add new PCM16 chunk to buffer
            const newChunk = event.data;
            const combined = new Int16Array(this.buffer.length + newChunk.length);
            combined.set(this.buffer);
            combined.set(newChunk, this.buffer.length);
            this.buffer = combined;
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        const channel = output[0];

        if (this.buffer.length < channel.length) {
            // Fill silence if buffer too short
            for (let i = 0; i < channel.length; i++) channel[i] = 0;
            return true;
        }

        // Copy buffer to output and normalize to [-1,1]
        for (let i = 0; i < channel.length; i++) {
            channel[i] = this.buffer[i] / 32768;
        }

        // Remove played samples from buffer
        this.buffer = this.buffer.slice(channel.length);
        return true;
    }
}

registerProcessor("linear16-player", Linear16Player);
