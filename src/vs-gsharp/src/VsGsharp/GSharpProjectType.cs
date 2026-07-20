using Microsoft.VisualStudio.ProjectSystem.VS;

[assembly: ProjectTypeRegistration(
    GSharp.VisualStudio.GSharpProjectType.ProjectTypeGuid,
    "G#",
    "G# Project Files (*.gsproj)",
    GSharp.VisualStudio.GSharpProjectType.ProjectExtension,
    GSharp.VisualStudio.GSharpProjectType.LanguageName,
    resourcePackageGuid: GSharp.VisualStudio.GSharpPackage.PackageGuidString,
    Capabilities = GSharp.VisualStudio.GSharpProjectType.InitialCapabilities,
    DisableAsynchronousProjectTreeLoad = true,
    PossibleProjectExtensions = GSharp.VisualStudio.GSharpProjectType.ProjectExtension,
    SupportsSolutionChangeWithoutReload = true)]

namespace GSharp.VisualStudio;

internal static class GSharpProjectType
{
    public const string ProjectTypeGuid = "F1526B4D-C1A8-4B42-B2F7-48DA6F9CA033";
    public const string ProjectExtension = "gsproj";
    public const string UniqueCapability = "GSharp";
    public const string LanguageName = "GSharp";
    public const string InitialCapabilities =
        "GSharp;CPS;Managed;.NET;AppDesigner;HandlesOwnReload;OpenProjectFile;PreserveFormatting;" +
        "ProjectConfigurationsDeclaredDimensions;ProjectPropertyInterception;LanguageService;" +
        "UseFileGlobs;AssemblyReferences;ProjectReferences;PackageReferences;DependenciesTree;LaunchProfiles";
}
