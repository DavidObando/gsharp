using Xunit;

namespace GSharp.VisualStudio;

public sealed class DotnetHostResolverTests
{
    [Theory]
    [InlineData("Microsoft.NETCore.App 10.0.10 [C:\\dotnet\\shared]", true)]
    [InlineData("Microsoft.NETCore.App 11.0.0 [C:\\dotnet\\shared]", true)]
    [InlineData("Microsoft.NETCore.App 9.0.12 [C:\\dotnet\\shared]", false)]
    [InlineData("Microsoft.AspNetCore.App 10.0.10 [C:\\dotnet\\shared]", false)]
    [InlineData("not a runtime", false)]
    public void HasRequiredRuntime_RecognizesNet10OrNewer(string output, bool expected)
    {
        Assert.Equal(expected, DotnetHostResolver.HasRequiredRuntime(output));
    }
}
