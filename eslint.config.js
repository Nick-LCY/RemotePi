// ESLint flat config — see docs/prds/m1-infrastructure.md §5
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/*.gen.ts',
      '**/coverage/**',
      '.pi/**',
      // Diagnostic / probe scripts that live next to a package but are
      // not part of its build graph. They run via `node` from the CLI
      // (e.g. `node worker/scripts/probe-handshake.mjs`) and aren't
      // type-checked against the worker's tsconfig — including them in
      // the project service trips a "was not found by the project
      // service" parsing error in CI. Excluding here is the cheapest
      // way to keep them out of the lint run without disabling rules
      // they don't need anyway.
      'worker/scripts/**/*.mjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs'],
        },
      },
    },
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['packages/bridge/src/**/*.ts', 'worker/src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
);
