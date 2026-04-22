async function gpt_image_editor(params, userSettings, authorizedResources) {
  const prompt = params.prompt;
  const openaikey = userSettings.openaikey;
  const quality = userSettings.quality || 'auto';
  const resolution = userSettings.resolution || 'auto';
  const background = userSettings.background || 'auto';
  const model = userSettings.model || 'gpt-image-2';

  if (!openaikey) {
    throw new Error(
      'No OpenAI key provided to the DALL-3 plugin. Please enter your OpenAI key in the plugin settings separately and try again.',
    );
  }

  let resultBase64;

  let attachedImages = (authorizedResources?.userMessage?.attachments || [])
    .filter((item) => item.type?.startsWith('image/'))
    .map((c) => ({
      url: c.url,
      name: c.name,
    }));

  const lastToolCallCards = authorizedResources?.previousRunOutput?.cards;

  if (!attachedImages.length && Array.isArray(lastToolCallCards)) {
    attachedImages = lastToolCallCards
      .filter((c) => c.type === 'image')
      .map((c) => ({
        url: c.image.url,
        name: 'output.png', // no name provided for tool output
      }));
  }

  const mode = attachedImages.length ? 'edit' : 'create';

  if (mode === 'create') {
    const body = {
      model: model,
      prompt: prompt,
      n: 1,
      size: resolution,
      quality: quality,
      output_format: 'png',
      background: background,
    };

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + openaikey,
      },
      body: JSON.stringify(body),
    };

    let response = await fetch(
      'https://api.openai.com/v1/images/generations',
      requestOptions,
    );
    if (response.status === 401) {
      throw new Error('Invalid OpenAI API Key. Please check your settings.');
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    let data = await response.json();

    resultBase64 = data.data[0].b64_json;
  } else if (mode === 'edit') {
    const imagesAsBlobs = await Promise.all(
      attachedImages.map(async ({ url, name }) => {
        if (url.startsWith('data:image/')) {
          const blob = await fetch(url).then((res) => res.blob());
          return { blob, name };
        }

        const response = await fetch(url);
        const blob = await response.blob();
        return { blob, name };
      }),
    );

    const formData = new FormData();

    // Model and prompt are simple
    formData.append('model', model);
    formData.append('prompt', prompt);
    formData.append('n', 1);
    formData.append('size', resolution);
    formData.append('quality', quality);
    formData.append('output_format', 'png');
    formData.append('background', background);

    // Load images (from URLs) and append as Blobs
    for (const { blob, name } of imagesAsBlobs) {
      formData.append('image[]', blob, name);
    }

    // Call the API
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaikey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error: ${err}`);
    }

    const result = await response.json();

    // Decode base64 and save as image (browser code varies; see below)
    resultBase64 = result.data[0].b64_json;
  } else {
    throw new Error('Invalid mode. Please use "create" or "edit".');
  }

  return {
    cards: [
      {
        type: 'image',
        image: {
          url: 'data:image/png;base64,' + resultBase64,
          alt: prompt.replace(/[[]]/, ''),
          sync: true,
        },
      },
    ],
  };
}
