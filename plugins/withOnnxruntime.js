const { withMainApplication } = require('@expo/config-plugins');

/**
 * Expo config plugin to add OnnxruntimePackage to MainApplication.kt
 * This is needed because onnxruntime-react-native doesn't autolink properly with Expo SDK 54
 */
const withOnnxruntime = (config) => {
  return withMainApplication(config, (config) => {
    const mainApplication = config.modResults;
    
    // Add import statement
    const importStatement = 'import ai.onnxruntime.reactnative.OnnxruntimePackage';
    if (!mainApplication.contents.includes(importStatement)) {
      // Add after the last import statement
      const lastImportIndex = mainApplication.contents.lastIndexOf('import ');
      const endOfLastImport = mainApplication.contents.indexOf('\n', lastImportIndex);
      mainApplication.contents = 
        mainApplication.contents.slice(0, endOfLastImport + 1) +
        importStatement + '\n' +
        mainApplication.contents.slice(endOfLastImport + 1);
    }
    
    // Add OnnxruntimePackage() to the packages list
    const packageAddition = 'add(OnnxruntimePackage())';
    if (!mainApplication.contents.includes(packageAddition)) {
      // Find the packages.apply block and add our package
      const applyBlockRegex = /PackageList\(this\)\.packages\.apply\s*\{[^}]*\}/;
      const match = mainApplication.contents.match(applyBlockRegex);
      
      if (match) {
        const oldBlock = match[0];
        // Insert before the closing brace
        const insertPosition = oldBlock.lastIndexOf('}');
        const newBlock = 
          oldBlock.slice(0, insertPosition) +
          '\n              // Manually add OnnxruntimePackage (not autolinked by Expo)\n' +
          '              add(OnnxruntimePackage())\n            ' +
          oldBlock.slice(insertPosition);
        
        mainApplication.contents = mainApplication.contents.replace(oldBlock, newBlock);
      }
    }
    
    return config;
  });
};

module.exports = withOnnxruntime;

