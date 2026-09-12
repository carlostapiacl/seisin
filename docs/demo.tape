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
#   - the request queue is filled by the HOOK, not by `run`. A plain `sh -c`
#     never triggers PreToolUse, so a GIF without a real agent cannot show
#     grant/deny without staging it. It shows `whose` instead, which is what
#     that user actually gets.

# vhs 0.12 on this machine captures frames but fails to encode, silently, with
# exit 0. So it emits frames and ffmpeg does the last step — see the command at
# the bottom of this file.
Output "/Users/carlos/seisin-demo/frames/"

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

Sleep 800ms
Type "seisin check" Sleep 400ms Enter
Sleep 3200ms
Type "clear" Enter
Sleep 400ms

# The agent does its work and reaches for something that is not its own.
# The kernel refuses, and it does not care how the command was spelled.
Type "seisin run frontend -- sh -c 'echo // fix >> src/api/orders.ts'" Sleep 500ms Enter
Sleep 4s

# And the part no other layer answers: whose it is.
# This works from inside the box too, which is the point of it.
Type "seisin run frontend -- seisin whose src/api/orders.ts" Sleep 500ms Enter
Sleep 3500ms

# Encode the frames vhs left behind:
#
#   cd ~/seisin-demo
#   ffmpeg -y -framerate 50 -i frames/frame-cursor-%05d.png \
#     -vf "fps=20,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
#     demo.gif
