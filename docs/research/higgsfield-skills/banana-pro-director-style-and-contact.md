# Style Extraction & Project Locking

Para mantener la coherencia visual en Nano Banana Pro a lo largo de m??ltiples generaciones, sigue este protocolo.

## 1. Extracci??n de Estilo (Style Extraction)
- **T??cnica**: Describe la paleta de colores dominante, el tipo de grano de pel??cula y la direcci??n de la luz de la imagen de referencia.
- **Prompt**: "Extract visual style from Image [ID]. Colors: [Colores]. Grain: [Tipo]. Lighting: [Dura/Suave]. Apply this exact style to the next prompt."

## 2. Bloqueo de Proyecto (Style Lock)
- Usa el mismo **Seed** en todas las generaciones.
- Mant??n fija la secci??n **L (Lighting)** y **C (Camera)** del framework SLCT. Solo var??a el **S (Subject)**.

# Contact Sheet Generator (6-Shot Template)

Usa estos comandos para pedirle a Nano Banana que genere una vista previa profesional:

## Plantilla: Cinematic Storyboard
- Prompt: "Generate a 3x2 grid contact sheet of a single scene from 6 different angles (Extreme Low Angle, High Angle, Eye Level, Close-up, Wide Shot, POV). Maintain exact character consistency."

## Plantilla: Commercial Lookbook
- Prompt: "Generate a 2x3 contact sheet showing the product from 6 different lighting setups (Studio, Natural, Rim Light, Mood, Softbox, High Contrast)."
