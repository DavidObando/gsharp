using System.ComponentModel.Composition;
using Microsoft.VisualStudio.ProjectSystem;
using Microsoft.VisualStudio.ProjectSystem.Properties;
using Microsoft.VisualStudio.ProjectSystem.VS;

namespace GSharp.VisualStudio;

[Export("Microsoft.VisualStudio.ProjectSystem.ProjectNodeComExtension")]
[ComServiceIid(typeof(IVsBrowseObjectContext), false)]
[AppliesTo(GSharpProjectType.UniqueCapability)]
[ProjectSystemContract(
    ProjectSystemContractScope.UnconfiguredProject,
    ProjectSystemContractProvider.Extension)]
[System.Runtime.InteropServices.ComVisible(true)]
internal sealed class GSharpBrowseObjectContext : IVsBrowseObjectContext
{
    [ImportingConstructor]
    public GSharpBrowseObjectContext(UnconfiguredProject unconfiguredProject)
    {
        UnconfiguredProject = unconfiguredProject;
    }

    public UnconfiguredProject UnconfiguredProject { get; }

    public ConfiguredProject? ConfiguredProject => null;

    public IPropertySheet? PropertySheet => null;

    public IProjectPropertiesContext? ProjectPropertiesContext => null;
}
