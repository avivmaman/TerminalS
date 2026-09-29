# TerminalS shell integration for Git Bash. Loaded via --rcfile, so it first
# replicates a normal login startup, runs the user's startup script, then wraps
# the prompt with OSC 633 markers.
[ -f /etc/profile ] && . /etc/profile
if [ -f ~/.bash_profile ]; then . ~/.bash_profile
elif [ -f ~/.bashrc ]; then . ~/.bashrc
fi

# User startup script configured in TerminalS (Profiles & Environment).
if [ -n "$TERMINALS_PRESCRIPT" ] && [ -f "$TERMINALS_PRESCRIPT" ]; then
  . "$TERMINALS_PRESCRIPT"
fi
unset TERMINALS_PRESCRIPT

__terminals_precmd() {
  local code=$?
  local cwd
  cwd=$(cygpath -w "$PWD" 2>/dev/null || printf '%s' "$PWD")
  printf '\033]633;D;%s\007\033]633;P;Cwd=%s\007' "$code" "$cwd"
}

PROMPT_COMMAND="__terminals_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="\[\033]633;A\007\]${PS1}\[\033]633;B\007\]"
