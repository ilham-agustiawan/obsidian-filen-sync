export const Bytes = {
	fromBase64(value: string): Uint8Array {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}

		return bytes;
	},

	toBase64(bytes: Uint8Array): string {
		let binary = "";
		const chunkSize = 0x8000;
		for (let index = 0; index < bytes.length; index += chunkSize) {
			const chunk = bytes.subarray(index, index + chunkSize);
			binary += String.fromCharCode(...chunk);
		}

		return btoa(binary);
	},

	isGzip(bytes: Uint8Array): boolean {
		return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	},

	async compress(bytes: Uint8Array): Promise<Uint8Array> {
		const cs = new CompressionStream("gzip");
		const writer = cs.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await new Response(cs.readable).arrayBuffer());
	},

	async decompress(bytes: Uint8Array): Promise<Uint8Array> {
		const ds = new DecompressionStream("gzip");
		const writer = ds.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await new Response(ds.readable).arrayBuffer());
	},

	async sha256hex(bytes: Uint8Array): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	},
} as const;
