package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Text
import Xunit

/// The driver binds imported `Nullable<T>` signatures from explicit references, as the SDK passes them (#5768).
/// Explicit references load the imported types into a MetadataLoadContext.
/// On a .NET 11 host, a runtime Nullable probe of these types throws NotSupportedException.
class Issue5768ImportedNullableValueTypeDriverTests {
    @Fact
    func ExplicitReferences_ImportedNullableValueTypeMembers_CompileAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace Imports5768;
public static class Lib5768 {
    public static int? Maybe(bool has) => has ? 42 : null;
    public static int Sum(int? left, int? right) => (left ?? 0) + (right ?? 0);
    public static System.Collections.Generic.List<int?> Items() => new() { 1, null, 3 };
}`, "Lib5768")
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
        let frameworkReferences = ReferenceResolver
            .HostTrustedPlatformAssemblyPaths()
            .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
            .Select((path string) -> "/r:" + path)
            .ToArray()
        Assert.NotEmpty(frameworkReferences)
        let references = frameworkReferences.Append("/r:" + library).ToArray()
        let (code, output) = fixture.TryCompile(`package App5768
import Imports5768
import System

let present = Lib5768.Maybe(true)
let absent = Lib5768.Maybe(false)
Console.Write("${present ?? -1},${absent ?? -1},${Lib5768.Sum(present, absent)},${Lib5768.Items().Count}")
`, "App5768", true, references)
        Assert.DoesNotContain("GS9998", output)
        Assert.True(code == 0, output)
        let app = Path.Combine(fixture.Directory, "App5768.dll")
        IlVerifier.Verify(app, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("42,-1,42,3"), fixture.RunBytes(app))
    }
}
