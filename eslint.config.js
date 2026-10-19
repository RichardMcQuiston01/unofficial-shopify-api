import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Google TypeScript Style Guide
      'no-restricted-exports': [
        'error',
        { restrictDefaultExports: { direct: true } },
      ],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/typedef': [
        'error',
        { variableDeclaration: true, variableDeclarationIgnoreFunction: true },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'] },
        {
          selector: 'variable',
          modifiers: ['const', 'global'],
          format: ['camelCase', 'UPPER_CASE'],
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'import', format: null },
      ],
    },
  },
  {
    files: ['*.config.ts', '*.config.js'],
    rules: { 'no-restricted-exports': 'off' },
  },
  prettier
);
