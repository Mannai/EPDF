import { useNodeResources } from '../../../src/main/features/textengine/nodeResources'

// Every unit test process can use the text engine (features call it for text the standard fonts cannot encode), the
// way the app's renderer does after `useRendererResources()`. Tests that configure it themselves simply do it again.
useNodeResources()
