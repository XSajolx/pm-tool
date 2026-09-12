// Vercel serverless function: every request to this project is rewritten here
// (see vercel.json) and handed to the compiled NestJS app.
export { default } from "../apps/api/dist/vercel.js";
