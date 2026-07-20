using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class TemplateAssetTests
{
    [Fact]
    public void Vsix_DeclaresProjectAndItemTemplateAssets()
    {
        XDocument manifest = XDocument.Load(Path.Combine(
            FindExtensionRoot(),
            "src",
            "VsGsharp",
            "source.extension.vsixmanifest"));

        string[] assetTypes = manifest.Descendants()
            .Where(element => element.Name.LocalName == "Asset")
            .Select(element => (string?)element.Attribute("Type"))
            .Where(type => type != null)
            .Cast<string>()
            .ToArray();

        Assert.Contains("Microsoft.VisualStudio.ProjectTemplate", assetTypes);
        Assert.Contains("Microsoft.VisualStudio.ItemTemplate", assetTypes);
    }

    [Fact]
    public void Templates_HaveExpectedEntryPoints()
    {
        string root = FindExtensionRoot();

        Assert.Equal(
            4,
            Directory.GetFiles(
                Path.Combine(root, "templates", "Project"),
                "*.vstemplate",
                SearchOption.AllDirectories)
                .Count(path => !File.ReadAllText(path).Contains("<Hidden>true</Hidden>")));
        Assert.Equal(
            4,
            Directory.GetFiles(
                Path.Combine(root, "templates", "Item"),
                "*.vstemplate",
                SearchOption.AllDirectories).Length);
    }

    private static string FindExtensionRoot()
    {
        DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null &&
               !File.Exists(Path.Combine(directory.FullName, "VsGsharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName ??
            throw new DirectoryNotFoundException("Could not locate src/vs-gsharp.");
    }
}
