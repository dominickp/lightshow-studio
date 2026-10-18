# Project Idea

## Concept
A 3D visualization of an environment with stage lighting equipment where the user can design lighting effects in time to music. Similar to what a nightclub or DJ might configure with stafe lighting and DMX coordination software, a simulator for stage lighting in time to music.

### Viewport 
The top section of the page contains a 3D viewport of an environment with stage/DJ lights, e.g. a room, concert stage, music venu. The user can add lighting equipment (spot light, strobe, etc...) which adds the light to the scene.

The user can orient the viewport to change prespective, or switch between set camera locations.

#### Graphics
This is a simulator of lighting effects in time with music. Lighting effects are the primary part of the appeal, so we must support robust effects and light rendering. Shadows, bloom, volumetrics, reflections, highlights, etc...

Producing a realistic 3D rendered scene with AI tools might be tough. So we need to get creative to see what is doable here. Maybe we can do a less-realistic but still aesthetically appealing art style, such as a PS1 style graphics which are not as detailed, but ensuing to support interesting lighting effects like reflections.

### Locations
Some location ideas:

- Home theater room
- Concert stage
- Underground EDM venue

### Possible hardware items we could support in the scene
Some effects, like the cryo cannons, would add additional sound effects to the seen (like a "PSSH" sound), for example.
#### Lighting
- Strobe Light: Emits rapid, intense flashes of light to create a dramatic, slow-motion freeze-frame effect on the crowd and stage.
- Spotlight: Projects a narrow, high-intensity beam of light onto a specific performer or focal point to keep them visible and centered.
- Moving Head Light: A versatile motorized fixture that can rotate in any direction to sweep dynamic beams, colors, and patterns across the venue.
- Wash Light: Floods a wide area of the stage or dance floor with a smooth, even wall of vibrant color.
- Laser Light: Projects sharp, concentrated beams of light that cut through fog to draw complex geometric patterns, aerial visual effects, and laser displays.
- Gobo Light: Uses patterned templates placed inside a light fixture to project customized shapes, textures, or logos onto surfaces.
- Blinder (Stage Blinder): Delivers a sudden, ultra-bright burst of warm light directed toward the audience to heighten energy during peak moments.
- PAR Can: A classic lighting staple that provides directional color lighting to build atmospheric ambient light across the stage.
- LED strips 
#### Atmospheric & Special Effects (SFX)
- Cryo Cannons / CO2 Jets: Blasts high-pressure, freezing plumes of carbon dioxide into the air that instantly dissipate, creating dramatic visual clouds and cool down the crowd on the dance floor. 
- Fog and Haze Machines: Releases a continuous mist into the room to catch light beams, making lasers, gobos, and moving heads visible as solid rays of light in three-dimensional space.
- Pyrotechnics & Cold Spark Fountains: Produces controlled bursts of sparks or flames
- Confetti & Streamer Cannons: Shoots massive bursts of colorful paper or metallic confetti into the air during major beat drops and festival climaxes.
- Bubble & Snow Machines: Pumps out dense fields of bubbles (sometimes filled with fog that bursts into clouds) or fake snow for playful, themed visual effects.
#### Stage & Dj Gear
- LED Video Walls & Displays: Modular video panels stacked behind or around the DJ to display high-resolution visual animations, live camera feeds, and custom brand graphics.

### Timeline/notefield
Below the viewport, stretching the entire width of the screen, is a timeline and playhead. The timeline is similar to the tracked interface FL Studio has. When the user adds or removes lighting equipment, new tracks are added or removed from the timeline. The user can use the timeline to enable or disable lighting effects in time with the music in the playhead.

Activating lighting effects in the tracks should be similar to adding musical notes in FL studio. It has to happen in time with the music, and some lights might need special effects like holds (keeping a light on for a duration) while in other cases you might want to blink on and off rapidly. Or some lights might fade in or out. We need to support these different actions in the timeline. And some actions (like fading) may not be supported by all lights.

### Playhead
The playhead site above the timeline and allows the user to scrub and jump to different parts of the song, and play and pause by pressing space. It should show the waveform of the song. The user can also zoom in and out on the playhead.

### Music
The app needs to allow the loading of music. The music must be evaluated for BPM and timing to properly sync grid locations in the timeline. The timeline notes need to be aligned with the beats of the song (e.g. 8th, 16ths, 24ths etc).

It would be nice if users could enter youtube videos, but analyzing and timing the audio from youtube might be challenging. Perhaps downloading the audio from youtube could be an option. But otherwise the user can load an audio file from disk.

## Runtime
I don't have a huge preference if it is a web app or a native app. Web would be nice for linking people and sharing scenes you created, but we still have the problem of the user audio in that sharing scenario. This is another advantage to using youtube videos, we could embed the YT url in the share link so the audio can always be pulled. But this won't work if we instead do local audio loading. In that case, you can't really share and the web way is less appealing. If its easier to do a native app in rust or something, we can do that approach.

I'm not hugely excited about using a major game engine like unity, would prefer we roll our own tiny thing or use something a little smaller if an off the shelf engine is needed for the lighting effects or something, but I don't have very strong opinions on this, happy to take suggestions.

