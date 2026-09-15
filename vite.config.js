import {defineConfig} from 'vite';

// Relative asset URLs work both at localhost and at a GitHub Pages repo path.
export default defineConfig({base:'./',server:{proxy:{'/turbo':{target:'http://127.0.0.1:5192',changeOrigin:true,rewrite:path=>path.replace(/^\/turbo/,'')}}}});
