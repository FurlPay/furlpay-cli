"use strict";
// `furlpay completion <shell>` — emit a completion script for the user to
// source/install. Static command lists (kept in sync with bin/furlpay.js).

const COMMANDS = [
  "login", "logout", "whoami", "config", "env", "status",
  "balance", "wallet", "send", "swap", "bridge", "pay", "tx",
  "invest", "market", "travel", "card", "earn",
  "listen", "trigger", "events", "logs", "docs", "api", "mcp",
  "dashboard", "completion", "help",
];

const SUBCOMMANDS = {
  config: ["get", "set"],
  env: ["sandbox", "live"],
  wallet: ["address", "fund", "export"],
  tx: ["list"],
  invest: ["buy", "sell", "portfolio", "quote", "watchlist", "history", "dca"],
  travel: ["search", "flights", "book", "bookings", "cancel"],
  card: ["list", "create", "freeze", "unfreeze", "limits", "transactions"],
  earn: ["deposit", "withdraw", "balance", "apy", "vaults", "history"],
  completion: ["bash", "zsh", "fish", "powershell"],
};

function bash() {
  return `# furlpay bash completion — add to ~/.bashrc:  eval "$(furlpay completion bash)"
_furlpay() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "\$cur") )
    return
  fi
  case "\$prev" in
${Object.entries(SUBCOMMANDS)
  .map(([cmd, subs]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(" ")}" -- "\$cur") );;`)
  .join("\n")}
  esac
}
complete -F _furlpay furlpay
`;
}

function zsh() {
  return `# furlpay zsh completion — add to ~/.zshrc:  eval "$(furlpay completion zsh)"
_furlpay() {
  local -a commands
  commands=(${COMMANDS.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\$words[2]" in
${Object.entries(SUBCOMMANDS)
  .map(([cmd, subs]) => `    ${cmd}) compadd ${subs.join(" ")};;`)
  .join("\n")}
  esac
}
compdef _furlpay furlpay
`;
}

function fish() {
  const lines = [
    `# furlpay fish completion — save as ~/.config/fish/completions/furlpay.fish`,
    `complete -c furlpay -f -n "__fish_use_subcommand" -a "${COMMANDS.join(" ")}"`,
  ];
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    lines.push(`complete -c furlpay -f -n "__fish_seen_subcommand_from ${cmd}" -a "${subs.join(" ")}"`);
  }
  return lines.join("\n") + "\n";
}

function powershell() {
  return `# furlpay PowerShell completion — add to $PROFILE:
#   furlpay completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName furlpay -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $subs = @{
${Object.entries(SUBCOMMANDS)
  .map(([cmd, subs]) => `    '${cmd}' = @('${subs.join("','")}')`)
  .join("\n")}
  }
  if ($words.Count -le 1 -or ($words.Count -eq 2 -and $wordToComplete)) {
    @('${COMMANDS.join("','")}') | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  } elseif ($subs.ContainsKey($words[1])) {
    $subs[$words[1]] | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
}
`;
}

function generate(shell) {
  switch (shell) {
    case "bash": return bash();
    case "zsh": return zsh();
    case "fish": return fish();
    case "powershell": case "pwsh": return powershell();
    default: return null;
  }
}

module.exports = { generate, COMMANDS, SUBCOMMANDS };
