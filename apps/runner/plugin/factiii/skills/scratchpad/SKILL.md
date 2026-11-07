---
name: scratchpad
description: Show the user something, or hand them a file, through the board's Scratchpad panel - by writing to $SCRATCHPAD. Anything you put there renders beside the terminal (image, screenshot, chart, video, audio, page, link, text) and can be saved to their machine or phone. TRIGGER when the user asks to see, show, preview, display or look at something; when you produce an image/diagram/chart/screenshot/recording; when you have a URL worth opening; when an answer is easier to look at than to read in a terminal; and whenever you need to GIVE the user a file - an export, a report, a bundle, a CSV, a log, a dump, anything they asked you to generate, save, download or send them. Writing it to $SCRATCHPAD is how a file gets off the runner and to the user.
license: ISC
---

# scratchpad

The terminal you are running in has a panel beside it. Anything you put in the
`$SCRATCHPAD` directory shows up there, drawn rather than printed: images
render, video and audio play, links become clickable, text and markdown are
shown as they are.

```bash
cp chart.png "$SCRATCHPAD/"
```

That is the whole interface. There is no command to run, nothing to install,
and nothing to tell the panel: it is watching the directory and updates on
its own within a second.

## What renders as what

The **extension decides**, so name the file for what it is:

| Write | You get |
|---|---|
| `.png .jpg .gif .webp .svg` | the image, click-to-open-full-size |
| `.mp4 .webm .mov` | a video player |
| `.mp3 .wav .m4a .ogg` | an audio player |
| `.html` | the page itself, rendered in a sandboxed frame |
| `.md` `.txt` and anything unlisted | the text as-is |
| `.url` | a clickable link (put the URL on the first line) |

A link:

```bash
echo "https://example.com/the-thing" > "$SCRATCHPAD/preview.url"
```

A note, when the answer is a shape rather than a sentence:

```bash
cat > "$SCRATCHPAD/rollout-plan.md" <<'MD'
# Rollout
1. staging, behind the flag
2. 10% of prod for a day
3. everyone
MD
```

## Handing a file to the user

Every item on the panel has a Save button, and the panel pulls the file off the
runner for them. So the scratchpad is not only for looking at: it is how you
give someone a file.

```bash
cp coverage-report.csv "$SCRATCHPAD/"
zip -qr "$SCRATCHPAD/failing-run-logs.zip" logs/
pg_dump "$DATABASE_URL" > "$SCRATCHPAD/schema-before-migration.sql"
```

A file meant for keeping does not have to render well. A `.zip` shows as
nothing much and a `.csv` as raw text, which is fine, because the user is going
to save it rather than read it in a narrow column. Name it for what it is so
they know what they are saving, and say in one line that it is there.

Nothing else you can do reaches the user's disk. If you write a file into the
workspace and tell them where it is, they have to go and get it themselves,
which on a phone means they cannot.

## Rules

- **Flat, plain names.** Letters, numbers, dots, dashes, spaces and
  underscores; no subdirectories, and never a leading dot. A name the panel
  cannot show is a drawing the user never sees.
- **Newest is shown first.** Rewriting a file under the same name replaces its
  card and moves it to the top, which is how you update a drawing rather than
  pile up `chart-2.png`, `chart-3.png`.
- **Under 12MB to be shown inline.** A bigger file is still listed, and the
  user can download it from the panel, but it will not render on the stage.
  Trim a recording if you want it watched rather than saved.
- **The board is shared.** One scratchpad per board, not per session, and it
  survives the session that drew on it. Clean up what has gone stale:
  `rm "$SCRATCHPAD/old-thing.png"`.

## When to reach for it

Use it whenever the answer is easier to look at than to read: a screenshot of
the change you just made, a generated chart, a diagram, a recorded repro, a
preview URL you just exposed, a table too wide for an 80-column shell.

And use it for anything the user is meant to end up holding: the export they
asked for, the report you generated, the logs from the run that failed, the
backup you just took.

Do not narrate it into the terminal as well. Write the file and say, in one
line, what you put on the scratchpad - the user is looking at the panel.
