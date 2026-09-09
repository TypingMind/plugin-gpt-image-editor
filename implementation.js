async function gpt_image_editor(params, userSettings, authorizedResources) {
  const prompt = params.prompt;
  const openaikey = userSettings.openaikey;
  const quality = userSettings.quality || 'auto';
  const resolution = userSettings.resolution || 'auto';
  const background = userSettings.background || 'auto';
  const model = userSettings.model || 'gpt-image-2.5-flare';

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

  const hasUserAttachments = attachedImages.length > 0;
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
    for (const image of attachedImages) {
      const { blob, name } = await loadImageForEdit({
        ...image,
        normalize: hasUserAttachments,
      });
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

async function loadImageForEdit({ url, name, normalize }) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status}`);
  }

  const source = await response.blob();
  if (!normalize) return { blob: source, name };

  const image = new Image();
  const canvas = document.createElement('canvas');
  const imageUrl = URL.createObjectURL(source);
  try {
    image.src = imageUrl;
    await image.decode();

    // Bound both canvas edges before allocating pixels for large photos (iOS).
    const initialScale = Math.min(
      1,
      4096 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    canvas.width = Math.max(1, Math.floor(image.naturalWidth * initialScale));
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * initialScale));
    // Re-encode sRGB pixels instead of forwarding source profiles and HDR gain maps.
    const context = canvas.getContext('2d', {
      colorSpace: 'srgb',
      colorType: 'unorm8',
    });
    if (!context) {
      throw new Error('Unable to prepare image: canvas is unavailable.');
    }
    // JPEG is opaque; keep PNG for other inputs so transparency is preserved.
    const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const extension = type === 'image/jpeg' ? '.jpg' : '.png';
    const maxBytes = 50_000_000;
    while (true) {
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, type, 0.92),
      );
      if (!blob) {
        throw new Error('Unable to encode image.');
      }
      if (blob.size < maxBytes) {
        return {
          blob,
          name: (name || 'image').replace(/\.[^.]+$/, '') + extension,
        };
      }
      if (canvas.width === 1 && canvas.height === 1) {
        throw new Error('Unable to reduce image below 50 MB.');
      }
      const scale = Math.min(0.8, Math.sqrt(maxBytes / blob.size) * 0.9);
      canvas.width = Math.max(1, Math.floor(canvas.width * scale));
      canvas.height = Math.max(1, Math.floor(canvas.height * scale));
    }
  } finally {
    canvas.width = canvas.height = 0;
    image.removeAttribute('src');
    URL.revokeObjectURL(imageUrl);
  }
}
