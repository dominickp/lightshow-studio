import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-tsc/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    rules: {
      // Unused symbols are dead code: warn so agents notice, but don't block.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // three/TSL types are unreadable; `any` is allowed where it earns its keep.
      "@typescript-eslint/no-explicit-any": "off",
      // Scripts and perf tooling legitimately log.
      "no-console": "off",
      eqeqeq: ["warn", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },

  // Dependency rule from docs/agent_docs/repo-shape.md: show-model stays pure.
  {
    files: ["packages/show-model/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "three",
              message: "show-model must not depend on three.js.",
            },
          ],
          patterns: [
            {
              group: ["three/*"],
              message: "show-model must not depend on three.js.",
            },
          ],
        },
      ],
    },
  },
);
