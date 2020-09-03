import R from 'ramda';

function removeFilesFromCompiler(versionModel) {
  if (
    versionModel.compiler &&
    versionModel.compiler.files &&
    versionModel.compiler.files.length &&
    versionModel.compiler.name
  ) {
    console.log('replacing before: ', versionModel.compiler);
    versionModel.compiler.files = [];
    if (versionModel.compiler.config && R.isEmpty(versionModel.compiler.config)) {
      versionModel.compiler = versionModel.compiler.name;
    }
    console.log('replacing after: ', versionModel.compiler);
  }
  return versionModel;
}

const removeFilesFromCompilerDeclaration = {
  name: 'remove latest from compiler',
  migrate: removeFilesFromCompiler
};

export default removeFilesFromCompilerDeclaration;
