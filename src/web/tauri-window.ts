export type Theme = "light" | "dark"
export function getCurrentWindow() {
  return {
    async setTheme(_theme: Theme | null): Promise<void> {},
    async setBackgroundColor(_color: string): Promise<void> {},
    async theme(): Promise<Theme> {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    },
  }
}
