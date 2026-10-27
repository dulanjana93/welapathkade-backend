declare module 'multer' {
  export class MulterError extends Error {
    code: string;
    constructor(code: string, field?: string);
  }
}
