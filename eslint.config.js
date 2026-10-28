import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

const sharedSonarRules = {
  ...sonarjs.configs.recommended.rules,
  // Pipeline, protocol parsers, and CLI state machines intentionally stay cohesive.
  "sonarjs/cognitive-complexity": "off",
  // Detection lexicons intentionally compile rich alternations; super-linear-regex stays enabled.
  "sonarjs/regex-complexity": "off",
  // Chained ternaries are idiomatic across parsers and telemetry formatters.
  "sonarjs/no-nested-conditional": "off",
};

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".stryker-tmp/**", "reports/**", "scratch/**"],
  },
  // src — full type-aware rules + SonarJS
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      sonarjs,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...tseslint.configs["recommended-type-checked"].rules,
      ...sharedSonarRules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  // Host CLI & certificate bootstrap intentionally invoke OS tools (openssl, certutil, security, netsh) from PATH
  {
    files: ["src/cli/**/*.ts", "src/proxy/certs.ts"],
    rules: {
      "sonarjs/no-os-command-from-path": "off",
    },
  },
  // scripts — syntax-only rules + SonarJS (no tsconfig project)
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
      sonarjs,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...sharedSonarRules,
      "sonarjs/no-os-command-from-path": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
