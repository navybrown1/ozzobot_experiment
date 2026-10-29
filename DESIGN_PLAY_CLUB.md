# Ozi Play Club

## Experience DNA

For two children aged 8 and 9, Ozi is the little robot who wants to play. The first screen offers a funny, touchable character and a concrete invitation. The signature moment: Ozi dances, suddenly freezes with enormous eyes, and challenges the child to beat its next round. Real robot reactions and the animated companion share the same named choreography.

## Aesthetic Direction

Playful and mischievous. A warm off-white clubhouse, ink typography, electric coral, violet, butter yellow, and mint. Rounded, sturdy typography (Avenir Next / Arial Rounded with system fallbacks). Plenty of air, oversized activity names, sticker-like illustrations. Replace the laboratory panels, tiny labels, and sarcastic adult prose.

## Visual System

Primary coral #ff6048; accent violet #8765ef; background #f7f6f2; contrast #25272a. Flat saturated fills, soft paper borders, restrained directional shadows. A large canvas renders a friendly robot with wheels, a translucent dome, expressive eyes, and colored LEDs. Canvas drawings also illustrate activities so no image or font service is required for the core experience.

## Interaction Strategy

Short rounds with a visible goal, progress, a win condition, and a one-click replay. Freeze Dance uses an honest reaction-time button (no claim that a camera observes the child). Copycat shows a growing color sequence and accepts child input. Color Quest asks for colored paper beneath the physical sensor, or explicitly selected colors in screen play. The move builder lets kids compose and preview bounded routines. Quick tricks have distinct anticipation, action, and punchline phases.

One cancelable run owns all activity. A fresh start click authorizes only its bounded routine/round; no background physical wander. Stop, dialog exit, hidden tab, and connection loss cancel queued work. A clear floor confirmation arms wheels for that session; every motor request is also checked by the bridge. Desk play has lights and screen animation with an explicit label, not pretend physical movement.

## Layout Intelligence

A compact clubhouse masthead and simple Play / Create / My badges navigation. The first viewport is a split composition: a big invitation and a generous interactive robot stage, with a featured Freeze Dance invitation. Three colorful activity tiles form the next row. Quick tricks and a small play streak complete the main screen. On phones, stage and invitation stack; game input and STOP remain reachable without horizontal scrolling.

## Implementation choices

Keep plain HTML/CSS/JavaScript and Vercel's static deployment. Use small isolated modules for scene, sound, transport, choreography, and activity state. Keep original legacy modules and storage untouched but unload them from the new screen. Persist only name, optional sound, scores, badges, and saved move recipes. Session arming and active games never persist across reloads.

## Success checks

Children can start a round without reading a manual. All games have interactive input and replay. Create changes the routine actually sent to the bridge. Hardware unavailable never displays Connected. Wheel commands require floor arming. Stop cancels pending activity and cannot restart it when a late response arrives. Automated browser tests cover the new experience; hardware claims require a separately observed live robot test.
