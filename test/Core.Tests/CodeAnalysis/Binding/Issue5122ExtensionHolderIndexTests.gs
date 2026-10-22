package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
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
        // Holders from several imported namespaces come back in reference-set
        // order, not in import order.
        // The expected order is the metadata order of the reference set, taken
        // straight from the assembly. Importing in both orders guarantees that
        // one of the two lookups differs from it unless the result is ordered.
        let expected = resolver
            .Assemblies
            .SelectMany((assembly Assembly) -> assembly.GetTypes())
            .Select((holder Type) -> holder.Name)
            .Where((name string) -> name == "First" || name == "Second")
            .ToArray()
        Assert.Equal(2, expected.Length)
        for first in[]string{"HoldersA5122", "HoldersB5122"} {
            let second = if first == "HoldersA5122" {
                "HoldersB5122"
            } else {
                "HoldersA5122"
            }
            let both = BoundScope(nil, resolver)
            Assert.True(both.TryImport(ImportSymbol(first, first, nil)))
            Assert.True(both.TryImport(ImportSymbol(second, second, nil)))
            let ordered = MemberLookup(BinderContext(both)).GetImportedExtensionClasses()
            Assert.Equal(expected, ordered.Select((holder Type) -> holder.Name).ToArray())
        }
        Assert.Equal(1L, measurements.GetCounter("extensions.holder-scans"))
    }

    @Fact
    func ExtensionHolders_ConcurrentFirstLookups_ScanTheReferenceSetOnce() {
        using let fixture = CSharpFixture(`namespace Race5122 {
    public static class Holder { public static int One(this string value) => 1; }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let measurements = CompilationMeasurements.Start("test")
        const workers = 8
        using let barrier = Barrier(workers)
        let tasks = List[Task[int32]]()
        for var i = 0; i < workers; i++ {
            tasks.Add(
                Task.Run(
                    () -> {
                        let scope_ = BoundScope(nil, resolver)
                        Assert.True(scope_.TryImport(ImportSymbol("Race5122", "Race5122", nil)))
                        let lookup = MemberLookup(BinderContext(scope_))
                        barrier.SignalAndWait()
                        return lookup.GetImportedExtensionClasses().Count
                    }
                )
            )
        }
        for count in Task.WhenAll(tasks).GetAwaiter().GetResult() {
            Assert.Equal(1, count)
        }
        Assert.Equal(1L, measurements.GetCounter("extensions.holder-scans"))
    }

    @Fact
    func ExtensionHolders_ProbeOnlyTypesInImportedNamespaces_AndEachNamespaceOnce() {
        using let fixture = CSharpFixture(`namespace Probed5122 {
    public static class Holder { public static int One(this string value) => 1; }
    public class Plain { }
}
namespace Untouched5122 {
    public static class Other { public static int Two(this string value) => 2; }
    public class A { }
    public class B { }
    public class C { }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let measurements = CompilationMeasurements.Start("test")
        for var i = 0; i < 3; i++ {
            let scope_ = BoundScope(nil, resolver)
            Assert.True(scope_.TryImport(ImportSymbol("Probed5122", "Probed5122", nil)))
            Assert.Equal(1, MemberLookup(BinderContext(scope_)).GetImportedExtensionClasses().Count)
        }
        // Only the two types declared in the imported namespace are probed, once.
        Assert.Equal(2L, measurements.GetCounter("extensions.holder-probes"))
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
