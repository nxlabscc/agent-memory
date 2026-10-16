// `.sql` files are imported as text (`with { type: "text" }`) so they travel
// inside the bundle. TypeScript does not know that form on its own.
declare module "*.sql" {
  const content: string;
  export default content;
}
