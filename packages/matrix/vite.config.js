export default {
    build: {
        lib: {
            entry: "src/lib.ts",
            formats: ["es", "iife"],
            name: "hydrogenMatrix",
        }
    },
    public: false,
    server: {
        hmr: false
    }
};