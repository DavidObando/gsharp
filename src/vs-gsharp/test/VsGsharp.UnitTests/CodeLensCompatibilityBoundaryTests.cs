using System;
using System.IO;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class CodeLensCompatibilityBoundaryTests
{
    [Fact]
    public void ClassicVsix_PackagesSupportedOutOfProcessCodeLensBoundary()
    {
        string root = FindRepositoryRoot();
        string project = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "VsGsharp.csproj"));
        string codeLensProject = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp.CodeLens", "VsGsharp.CodeLens.csproj"));
        string manifest = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "source.extension.vsixmanifest"));
        string provider = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp.CodeLens", "GSharpReferenceCodeLensDataPointProvider.cs"));
        string tagger = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "GSharpCodeLensTagger.cs"));
        string listener = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "GSharpCodeLensCallbackListener.cs"));

        Assert.Contains("<TargetFramework>net472</TargetFramework>", project);
        Assert.Contains("<TargetFramework>net472</TargetFramework>", codeLensProject);
        Assert.DoesNotContain("Microsoft.VisualStudio.Extensibility.Sdk", project);
        Assert.Contains("Microsoft.VisualStudio.CodeLensComponent", manifest);
        Assert.Contains("IAsyncCodeLensDataPointProvider", provider);
        Assert.Contains("ICodeLensCallbackService", provider);
        Assert.Contains("GetReferenceCodeLensesAsync", tagger);
        Assert.Contains("CurrentSnapshot.Version.VersionNumber != requestedVersion", tagger);
        Assert.Contains("FileActionOccurred", tagger);
        Assert.Contains("refreshAll", tagger);
        Assert.Contains("GSharpCodeLensAnchor.Find", tagger);
        Assert.Contains(
            "ElementDescription = $\"{referenceCount}|{navigationLine}|{navigationCharacter}\"",
            tagger);
        Assert.DoesNotContain("GSharp.Core", tagger);
        Assert.Contains("VSStd97CmdID.FindReferences", listener);
    }

    [Fact]
    public void ReferenceCodeLensContract_IsAvailableAtBothRpcBoundaries()
    {
        string root = FindRepositoryRoot();
        string server = File.ReadAllText(Path.Combine(
            root, "src", "LanguageServer", "Server", "LspServer.cs"));
        string client = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "GSharpLanguageServerRpc.cs"));

        Assert.Contains("[JsonRpcMethod(\"gsharp/referenceCodeLens\"", server);
        Assert.Contains("CodeLensComputer.ComputeReferenceLenses", server);
        Assert.Contains("ReferenceCodeLensMethod = \"gsharp/referenceCodeLens\"", client);
        Assert.Contains("GetReferenceCodeLensesAsync", client);
    }

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new DirectoryNotFoundException("Could not locate the GSharp repository.");
    }
}
