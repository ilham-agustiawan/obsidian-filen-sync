const notAvailable = (name: string): never => {
	throw new Error(`fs-extra.${name} is not available in the Obsidian plugin runtime.`);
};

const fsExtraShim = {
	constants: {},
	exists: async () => notAvailable("exists"),
	stat: async () => notAvailable("stat"),
	rm: async () => notAvailable("rm"),
	mkdir: async () => notAvailable("mkdir"),
	ensureDir: async () => notAvailable("ensureDir"),
	writeFile: async () => notAvailable("writeFile"),
	appendFile: async () => notAvailable("appendFile"),
	readFile: async () => notAvailable("readFile"),
	open: async () => notAvailable("open"),
	close: async () => notAvailable("close"),
	read: async () => notAvailable("read"),
	readdir: async () => notAvailable("readdir"),
	createReadStream: () => notAvailable("createReadStream"),
	createWriteStream: () => notAvailable("createWriteStream"),
};

export default fsExtraShim;
