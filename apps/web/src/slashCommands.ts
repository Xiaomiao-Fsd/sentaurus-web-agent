export type SlashCommandSuggestion = {
  command: "/goal" | "/plan" | "/side" | "/help";
  label: string;
  description: string;
  template: string;
  usage: string;
};

const SLASH_COMMANDS: SlashCommandSuggestion[] = [
  {
    command: "/goal",
    label: "/goal",
    description: "Show or update the durable goal lifecycle for this session.",
    template: "/goal ",
    usage: "/goal [set|pause|resume|block|complete|clear] [text]"
  },
  {
    command: "/plan",
    label: "/plan",
    description: "Enter or manage read-only planning before execution.",
    template: "/plan ",
    usage: "/plan [show|enter|approve|exit|clear|step]"
  },
  {
    command: "/side",
    label: "/side",
    description: "Run a side investigation without replacing the main thread.",
    template: "/side ",
    usage: "/side <task>"
  },
  {
    command: "/help",
    label: "/help",
    description: "Show VM worker slash-command help.",
    template: "/help",
    usage: "/help"
  }
];

export function slashCommandQuery(value: string): string | null {
  const match = value.match(/^\s*(\/[^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function slashCommandSuggestions(value: string): SlashCommandSuggestion[] {
  const query = slashCommandQuery(value);
  if (!query) return [];
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(query));
}

export function applySlashCommandSuggestion(currentValue: string, suggestion: SlashCommandSuggestion): string {
  const leadingWhitespace = currentValue.match(/^\s*/)?.[0] || "";
  return `${leadingWhitespace}${suggestion.template}`;
}

export function nextSlashSuggestionIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function completeSlashCommand(command: SlashCommandSuggestion["command"]): string {
  return `${command} `;
}

export function slashCommandIsIncomplete(value: string): boolean {
  return slashCommandSuggestions(value).length > 0;
}
