import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        chrome: "readonly",
        indexedDB: "readonly",
        OffscreenCanvas: "readonly",
        createImageBitmap: "readonly",
        Image: "readonly",
        FileReader: "readonly",
        ClipboardItem: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        getComputedStyle: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "warn",
    },
  },
  {
    ignores: ["harness/**", "artifacts/**", ".devloop/**", "assets/**"],
  },
];
