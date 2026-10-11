export default defineNuxtConfig({
  compatibilityDate: "2026-10-11",
  css: ["~/assets/play.css"],
  runtimeConfig: {
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? "",
    public: {
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "",
    },
  },
  app: {
    head: {
      title: "book",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { name: "theme-color", content: "#f4efe6" },
      ],
      script: [
        {
          innerHTML:
            '(function(){try{var s=localStorage.getItem("book-text-size");if(s)document.documentElement.style.setProperty("--reading-size",s);var t=localStorage.getItem("book-theme");if(t)document.documentElement.dataset.theme=t;}catch(e){}})();',
          tagPosition: "head",
        },
      ],
    },
  },
  nitro: {
    externals: {
      inline: [/^@book\//],
    },
    vercel: {
      functions: {
        maxDuration: 60,
      },
    },
  },
});
