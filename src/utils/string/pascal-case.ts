export default function pascalCase(str: string): string {
  const capitalized = str.charAt(0).toUpperCase() + str.slice(1);
  return capitalized.replace(/-([a-z])/g, g => g[1].toUpperCase());
}
