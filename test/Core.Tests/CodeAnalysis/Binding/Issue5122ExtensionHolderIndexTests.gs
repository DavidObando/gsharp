package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Linq
import Xunit

class Issue5122ExtensionHolderIndexTests {
    @Fact
    func ExtensionHolders_AreScannedOncePerReferenceSet_AcrossBinderContexts() {
        using let fixture = CSharpFixture(`namespace HoldersA5122 {
    public static class First { public static int One(this string value) => 1; }
}
namespace HoldersB5122 {
    public static class Second { public static int Two(this string value) => 2; }
    public static class NotAHolder { public static int Plain(string value) => 3; }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let measurements = CompilationMeasurements.Start("test")
        for var i = 0; i < 5; i++ {
            let scope_ = BoundScope(nil, resolver)
            Assert.True(scope_.TryImport(ImportSymbol("HoldersA5122", "HoldersA5122", nil)))
            let lookup = MemberLookup(BinderContext(scope_))
            Assert.Equal(
                []string{"First"},
                lookup.GetImportedExtensionClasses().Select((holder Type) -> holder.Name).ToArray()
            )
        }
        let other = BoundScope(nil, resolver)
        Assert.True(other.TryImport(ImportSymbol("HoldersB5122", "HoldersB5122", nil)))
        let otherClasses = MemberLookup(BinderContext(other)).GetImportedExtensionClasses()
        Assert.Equal([]string{"Second"}, otherClasses.Select((holder Type) -> holder.Name).ToArray())
        Assert.Equal(1L, measurements.GetCounter("extensions.holder-scans"))
    }

    @Fact
    func ExtensionHolders_ReapplyInternalAccessPerConsumer_WithSharedIndex() {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend5122")]
namespace Access5122 {
    internal static class Hidden { public static int H(this string value) => 1; }
    public static class Visible { public static int V(this string value) => 2; }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let scope_ = BoundScope(nil, resolver)
        Assert.True(scope_.TryImport(ImportSymbol("Access5122", "Access5122", nil)))
        resolver.CurrentAssemblyName = "Other5122"
        let outsider = MemberLookup(BinderContext(scope_)).GetImportedExtensionClasses()
        Assert.Equal([]string{"Visible"}, outsider.Select((holder Type) -> holder.Name).ToArray())
        resolver.CurrentAssemblyName = "Friend5122"
        let friend = MemberLookup(BinderContext(scope_)).GetImportedExtensionClasses()
        Assert.Equal(
            []string{"Hidden", "Visible"},
            friend.Select((holder Type) -> holder.Name).OrderBy((name string) -> name, StringComparer.Ordinal).ToArray()
        )
    }
}
