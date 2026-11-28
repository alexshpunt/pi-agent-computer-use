# Animated 3D capture fixture

This page displays a rotating cube and orbiting spheres for capture experiments. It loads Three.js 0.180.0 from jsDelivr, so the browser needs network access and WebGL. Loading and rendering errors appear on the page.

From the repository root, start a local server:

```sh
python3 -m http.server 8000 --directory demo/animated-3d
```

Open `http://localhost:8000/` in a separate Chrome window. Verify that the scene moves before testing capture. When testing a minimized window, request multiple captures over time and record errors separately from identical images. A browser stops rendering while minimized, so unchanged pixels alone do not establish whether capture is fresh. With a driver that supports `minimized_capture`, each read restores the window invisibly, captures it and minimizes it again, so successive images of the minimized window differ: the cube is in a new position every time ([Minimized windows](../../docs/minimized-windows.md)). Close the test window and stop the server after the experiment.
