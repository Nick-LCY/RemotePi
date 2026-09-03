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
