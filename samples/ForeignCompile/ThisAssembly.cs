// Stands in for a real Nerdbank.GitVersioning-generated ThisAssembly.cs
// (issue #2214). NBGV writes this shape into obj/ and adds it to @(Compile)
// via its own MSBuild target; a synthetic stand-in exercises the same "stray
// .cs Compile item" mechanism without depending on the NBGV package/git repo
// state in this sample.
namespace ForeignCompile
{
    internal static class ThisAssembly
    {
        internal const string AssemblyVersion = "1.2.3.0";
        internal const string AssemblyFileVersion = "1.2.3.4";
        internal const string AssemblyInformationalVersion = "1.2.3+abcdef1234567890abcdef1234567890abcdef12";
        internal const string AssemblyName = "ForeignCompile";
        internal const string RootNamespace = "ForeignCompile";
        internal const string GitCommitId = "abcdef1234567890abcdef1234567890abcdef12";
    }
}
