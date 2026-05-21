class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 320; // ~20ms at 16kHz
    this.buffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];

    if (!input || !input[0]) return true;

    const channelData = input[0]; // Float32Array

    for (let i = 0; i < channelData.length; i++) {
      // Convert Float32 to Int16 (PCM16)
      const sample = Math.max(-1, Math.min(1, channelData[i]));

      // Accumulate in buffer
      if (this.bufferIndex < this.bufferSize) {
        this.buffer[this.bufferIndex++] = sample * 32767;
      }

      // Flush buffer when full
      if (this.bufferIndex >= this.bufferSize) {
        // Clone buffer to send
        const bufferToSend = this.buffer.slice(0);
        this.port.postMessage(bufferToSend.buffer);

        // Reset index
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
