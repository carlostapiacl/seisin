# The README's GIF, recorded with vhs — https://github.com/charmbracelet/vhs
#
#   cd ~/seisin-demo && vhs <path-to>/docs/demo.tape
#
# A script rather than a hand recording, so it can be regenerated identically
# when the output changes. That is the only way a GIF does not age badly.
#
# Three things that each cost an attempt, for whoever edits this next:
#
#   - vhs wants DOUBLE quotes outside and single inside. It cannot escape them.
#   - bash does not expand aliases outside interactive mode, so `seisin` has to
#     be a real executable on PATH. An alias looks identical and does nothing.
#   - the request queue used to be filled by the HOOK alone, so a plain `sh -c`
#     showed a bare refusal and the GIF had to fall back to `whose`. Since
#     2026-09-14 `run` reads the kernel's own denials, so the queue fills with
#     no agent and no hook involved — which is why the recording can show the
#     block and the request together, as a real user now sees them.

# vhs 0.12 captures frames but fails to encode, silently, with exit 0. So it
# emits frames and ffmpeg does the last step — see the command at the bottom.
#
# Two more things, found regenerating this on 2026-09-21:
#
#   - vhs wants to CREATE the frames directory. Pre-creating it, or reusing a
#     path it has failed on before, gets you a clean run and zero frames.
#     Delete the whole output directory before recording.
#   - vhs does not use the ffmpeg on your PATH, so a shim that patches flags
#     for a newer ffmpeg does nothing. The encode below is yours to run.
# vhs needs an absolute path here — a relative one silently writes nowhere.
Output "/tmp/seisin-demo/frames/"

Set Shell bash
Set FontSize 17
Set Width 1100
Set Height 660
Set Padding 24
Set Theme "GitHub Dark"
Set TypingSpeed 45ms

Hide
Type "export PS1='$ ' PATH=$PWD/.bin:$PATH" Enter
Type "clear" Enter
Show

# The policy first, because the two scenes after it are meaningless without it.
# `seisin check` was here and stopped fitting: it prints the map AND every
# standing limit, which is right for a command you read before trusting the tool
# and wrong for the opening frame of a recording — the map scrolled off the top
# behind a wall of caveats. The file is three lines and says the same thing.
Sleep 800ms
Type "cat seisin.toml" Sleep 400ms Enter
Sleep 3000ms
Type "clear" Enter
Sleep 400ms

# The agent does its work and reaches for something that is not its own.
# The kernel refuses, and it does not care how the command was spelled.
Type "seisin run frontend -- sh -c 'echo // fix >> src/api/orders.ts'" Sleep 500ms Enter
Sleep 4s

# The refusal already named the owner and left a request behind — that is the
# part no other layer answers, and since 2026-09-14 it arrives with the block
# rather than waiting to be asked for.
#
# Asking directly still works, and works from INSIDE the box, which is the point
# of it: the agent that was refused can find out who to hand the work to.
Type "seisin run frontend -- seisin whose src/api/orders.ts" Sleep 500ms Enter
Sleep 3500ms

# Encode the frames vhs left behind:
#
#   cd /tmp/seisin-demo
#   ffmpeg -y -framerate 50 -i frames/frame-text-%05d.png \
#     -vf "fps=20,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
#     demo.gif
