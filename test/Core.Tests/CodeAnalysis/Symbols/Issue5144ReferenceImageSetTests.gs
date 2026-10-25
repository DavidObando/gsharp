// <copyright file="Issue5144ReferenceImageSetTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import AssemblyIdentity = GSharp.Core.CodeAnalysis.Symbols.AssemblyIdentity
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import SpecialType = GSharp.Core.CodeAnalysis.Symbols.SpecialType
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0209 PR 1 (#5144): the handle-backed reference set, built beside the `MetadataLoadContext` and
/// compared on names. These tests pin that the set reports the names, the order and the type references
/// that the context reports, and that every difference is counted.
open class Issue5144ReferenceImageSetTests {
    @Fact
    func SetNames_Equal_ReflectionNames_InOrder_ForEveryReferenceAssembly() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        Assert.True(set.SearchedCount > 50, "expected the BCL closure")
        Assert.Equal(resolver.Assemblies.Length, set.SearchedCount)
        var forwarded = 0
        for var i = 0; i < resolver.Assemblies.Length; i++ {
            // Exact order, no sorting: the first assembly to declare a name owns it.
            let expected = ReflectionNames(resolver.Assemblies[i])
            let actual = set.GetIndexedNames(i)
            Assert.True(
                expected.SequenceEqual(actual),
                "${resolver.Assemblies[i].GetName().Name}: ${Difference(expected, actual)}"
            )
            forwarded += set.Modules[i].Forwarded.Count
        }
        Assert.True(forwarded > 0, "the closure must include type forwarders")
    }

    @Fact
    func IndexedNames_Resolve_ToTheTypeReflectionFindsFirst() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        // First writer wins across assemblies, exactly as the reflection scan did.
        let expected = Dictionary[string, Type](StringComparer.Ordinal)
        for assembly in resolver.Assemblies {
            for name in ReflectionNames(assembly) {
                if !expected.ContainsKey(name) {
                    expected[name] = assembly.GetType(name)!!
                }
            }
        }
        var resolved = 0
        for (name, type) in expected {
            let found = set.TryResolveName(name)!!
            Assert.True(found.IsResolved, name)
            Assert.Equal(type.FullName, found.FullName)
            Assert.Equal(type.Assembly.GetName().Name, found.Module!!.Identity.Name)
            resolved++
        }
        Assert.True(resolved > 1000)
    }

    @Fact
    func CoreClosure_HasNoDisagreements_OnNamesTypeReferencesAndWellKnownTypes() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        var typeReferences = 0
        for module in set.Modules {
            typeReferences += module.Reader.GetTableRowCount(TableIndex.TypeRef)
        }
        Assert.True(typeReferences > 1000, "the closure must hold type references")
        let disagreements = MetadataModelComparison.Compare(resolver, set)
        Assert.True(disagreements.Count == 0, MetadataModelComparison.FormatReport(disagreements))
        // The well-known table finds the core types where the closure supplies them.
        Assert.True(set.WellKnown.Get(SpecialType.Object).IsResolved)
        Assert.Equal("System.Object", set.WellKnown.Get(SpecialType.Object).FullName)
        Assert.Equal("System.Nullable`1", set.WellKnown.Get(SpecialType.Nullable).FullName)
        Assert.Equal("System.ValueTuple`8", set.WellKnown.Get(SpecialType.ValueTuple8).FullName)
        Assert.True(set.WellKnown.FullNames.Length > 100)
    }

    @Fact
    func EveryTypeReference_OfTheClosure_ResolvesToADefinitionOrAMissingType() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        var resolved = 0
        var missing = 0
        for module in set.Modules {
            for handle in module.Reader.TypeReferences {
                let answer = set.ResolveTypeReference(module, handle)
                if answer.IsResolved {
                    Assert.True(answer.Module!!.TryGetDefinition(answer.FullName, out _), answer.FullName)
                    resolved++
                } else {
                    Assert.NotNull(answer.Missing)
                    missing++
                }
                // The memo hands out one object for one row.
                Assert.Same(answer, set.ResolveTypeReference(module, handle))
            }
        }
        Assert.True(resolved > 1000)
        Assert.True(resolved > missing)
    }

    @Fact
    func NamesNeedingReflectionEscaping_AreSpelledAsReflectionSpellsThem() {
        let path = SaveEscapingAssembly()
        using let resolver = HandleResolver([]string{path})
        let set = resolver.ImageSet!!
        let index = Array.FindIndex(resolver.Assemblies.ToArray(), (a Assembly) -> a.GetName().Name == "Escaping5144")
        Assert.True(index >= 0)
        let expected = ReflectionNames(resolver.Assemblies[index])
        let actual = set.GetIndexedNames(index)
        // Reflection really escapes: the witness is in the expected names, not only in the product.
        Assert.Contains("Odd5144\\[Name", expected)
        Assert.Contains("N5144\\,Ns.Odd5144\\+Name", expected)
        Assert.Contains("Out5144\\+er+In\\*ner", expected)
        Assert.Contains("Back5144\\\\Slash", expected)
        Assert.True(expected.SequenceEqual(actual), Difference(expected, actual))
        // The legacy entry point still refuses these names and leaves them to reflection.
        Assert.False(
            MetadataTypeNameReader.TryReadNames(
                File.ReadAllBytes(path),
                List[string](),
                List[KeyValuePair[string, string]](),
                Dictionary[string, List[string]]()
            )
        )
        // The set resolves the escaped spelling, and a nested type resolves through its enclosing type.
        let nested = set.TryResolveNameInAssembly("Escaping5144", "Out5144\\+er+In\\*ner")
        Assert.True(nested != nil && nested.IsResolved)
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func Escape_AddsABackslashBeforeEachSpecialCharacter() {
        Assert.Equal("Plain", MetadataTypeNameReader.Escape("Plain"))
        Assert.Equal("a\\,b\\+c\\&d\\*e\\[f\\]g\\\\h", MetadataTypeNameReader.Escape("a,b+c&d*e[f]g\\h"))
        Assert.Equal("Ns\\+x.Name\\[", MetadataTypeNameReader.QualifyEscaped("Ns+x", "Name["))
        Assert.Equal("Name", MetadataTypeNameReader.QualifyEscaped("", "Name"))
    }

    @Fact
    func TypeReferences_ThroughAForward_ResolveToTheDestinationDefinition() {
        // The consumer binds to Facade5144 version 1, which defines the types. The set holds version 2,
        // which only forwards them to Target5144.
        using let facadeV1 = CSharpFixture(
            "namespace N5144 { public class Outer { public class Inner {} } }",
            assemblyName: "Facade5144"
        )
        using let target = CSharpFixture(
            "namespace N5144 { public class Outer { public class Inner {} } }",
            assemblyName: "Target5144"
        )
        using let facadeV2 = CSharpFixture(
            "[assembly: System.Runtime.CompilerServices.TypeForwardedTo(typeof(N5144.Outer))]",
            []MetadataReference{MetadataReference.CreateFromFile(target.AssemblyPath)},
            assemblyName: "Facade5144"
        )
        using let consumer = CSharpFixture(
            "public class Consumer5144 { public N5144.Outer.Inner Field; public N5144.Outer Other; }",
            []MetadataReference{MetadataReference.CreateFromFile(facadeV1.AssemblyPath)},
            assemblyName: "Consumer5144"
        )
        using let resolver = HandleResolver([]string{consumer.AssemblyPath, facadeV2.AssemblyPath, target.AssemblyPath})
        let set = resolver.ImageSet!!
        let consumerModule = set.FindModule("Consumer5144")!!
        var checkedReferences = 0
        for handle in consumerModule.Reader.TypeReferences {
            let reference = consumerModule.Reader.GetTypeReference(handle)
            let name = consumerModule.Reader.GetString(reference.Name)
            if name != "Outer" && name != "Inner" {
                continue
            }
            let answer = set.ResolveTypeReference(consumerModule, handle)
            Assert.True(answer.IsResolved, name)
            // The facade never appears in an answer.
            Assert.Equal("Target5144", answer.Module!!.Identity.Name)
            Assert.Equal(
                if name == "Outer" {
                    "N5144.Outer"
                } else {
                    "N5144.Outer+Inner"
                },
                answer.FullName
            )
            checkedReferences++
        }
        Assert.Equal(2, checkedReferences)
        // An assembly-qualified lookup of a nested type goes through the facade too.
        let throughFacade = set.TryResolveNameInAssembly("Facade5144", "N5144.Outer+Inner")!!
        Assert.True(throughFacade.IsResolved)
        Assert.Equal("Target5144", throughFacade.Module!!.Identity.Name)
        Assert.Equal("N5144.Outer+Inner", throughFacade.FullName)
        Assert.Null(set.TryResolveNameInAssembly("Facade5144", "N5144.Outer+Missing"))
        // The facade lists the forwarded names, the nested one too, as reflection does.
        let facadeIndex = Array.FindIndex(
            resolver.Assemblies.ToArray(),
            (a Assembly) -> a.GetName().Name == "Facade5144"
        )
        Assert.Equal(ReflectionNames(resolver.Assemblies[facadeIndex]), set.GetIndexedNames(facadeIndex))
        Assert.Contains("N5144.Outer+Inner", set.GetIndexedNames(facadeIndex))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func ForwardCycle_EndsWithoutAnAnswer() {
        // CycleA5144 and CycleB5144 forward the same type to each other. Neither defines it.
        let set = ReferenceImageSet(
            ImmutableArray.Create(
                ReferenceImage(BuildForwarder("CycleA5144", "CycleB5144", "N5144C", "Looped"), nil, true),
                ReferenceImage(BuildForwarder("CycleB5144", "CycleA5144", "N5144C", "Looped"), nil, true)
            )
        )
        Assert.Null(set.TryResolveNameInAssembly("CycleA5144", "N5144C.Looped"))
        Assert.Null(set.TryResolveNameInAssembly("CycleB5144", "N5144C.Looped"))
        // Neither module lists the name: no target declares it.
        Assert.DoesNotContain("N5144C.Looped", set.GetIndexedNames(0))
        Assert.DoesNotContain("N5144C.Looped", set.GetIndexedNames(1))
        Assert.Null(set.TryResolveName("N5144C.Looped"))
    }

    @Fact
    func UnresolvableTypeReference_IsAnInternedMissingType() {
        using let lib = CSharpFixture(
            "namespace N5144M { public class Gone {} public class Other {} }",
            assemblyName: "Lib5144"
        )
        using let first = CSharpFixture(
            "public class First5144 { public N5144M.Gone A; public N5144M.Other B; }",
            []MetadataReference{MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "First5144"
        )
        using let second = CSharpFixture(
            "public class Second5144 { public N5144M.Gone A; }",
            []MetadataReference{MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "Second5144"
        )
        // Lib5144 is not in the reference set.
        using let resolver = HandleResolver([]string{first.AssemblyPath, second.AssemblyPath})
        let set = resolver.ImageSet!!
        let missing = Dictionary[string, MissingTypeSymbol]()
        for module in[]MetadataModule{set.FindModule("First5144")!!, set.FindModule("Second5144")!!} {
            for handle in module.Reader.TypeReferences {
                let reference = module.Reader.GetTypeReference(handle)
                let name = module.Reader.GetString(reference.Namespace) + "." + module.Reader.GetString(reference.Name)
                if !name.StartsWith("N5144M.") {
                    continue
                }
                let answer = set.ResolveTypeReference(module, handle)
                Assert.False(answer.IsResolved, name)
                let symbol = answer.Missing!!
                Assert.Equal("Lib5144", symbol.AssemblyIdentity!!.Name)
                Assert.Equal(name, symbol.FullName)
                if missing.TryGetValue(name, out var earlier) {
                    // The same pair from another module is the same object.
                    Assert.Same(earlier, symbol)
                } else {
                    missing[name] = symbol
                }
            }
        }
        Assert.Equal(2, missing.Count)
        Assert.NotSame(missing["N5144M.Gone"], missing["N5144M.Other"])
        // Equal to itself only: another assembly identity or another name is another symbol.
        let identity = missing["N5144M.Gone"].AssemblyIdentity
        Assert.Same(missing["N5144M.Gone"], set.GetMissing(identity, "N5144M.Gone"))
        Assert.NotSame(missing["N5144M.Gone"], set.GetMissing(nil, "N5144M.Gone"))
        Assert.NotSame(
            missing["N5144M.Gone"],
            set.GetMissing(
                AssemblyIdentity("Lib5144", Version(9, 0, 0, 0), "", ImmutableArray[uint8].Empty),
                "N5144M.Gone"
            )
        )
        // The context cannot supply them either.
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func WellKnownType_TheSetDoesNotSupply_IsAMissingTypeAndNeverAHostType() {
        using let fixture = CSharpFixture("public class Alone5144 {}", assemblyName: "Alone5144")
        let set = ReferenceImageSet(
            ImmutableArray.Create(ReferenceImage(File.ReadAllBytes(fixture.AssemblyPath), fixture.AssemblyPath, true))
        )
        let answer = set.WellKnown.Get(SpecialType.Object)
        Assert.False(answer.IsResolved)
        Assert.Equal("System.Object", answer.Missing!!.FullName)
        Assert.Same(answer, set.WellKnown.Get(SpecialType.Object))
        Assert.Same(answer.Missing, set.GetMissing(nil, "System.Object"))
        Assert.Null(set.WellKnown.TryGet("Alone5144"))
        Assert.Throws[ArgumentOutOfRangeException](() -> set.WellKnown.Get(SpecialType.None))
    }

    @Fact
    func WellKnownType_PrefersAPublicCopyOverAnInternalShadowThatComesFirst() {
        // A dependency can embed an internal copy of a framework type (#3445, #4233). The raw first writer is
        // that copy. The well-known table must land on the public type, as the resolver does.
        using let shadow = CSharpFixture(
            "namespace System.Runtime.CompilerServices { internal sealed class NullableAttribute : System.Attribute {} }",
            assemblyName: "Shadow5144"
        )
        using let resolver = HandleResolver([]string{shadow.AssemblyPath})
        let set = resolver.ImageSet!!
        let name = "System.Runtime.CompilerServices.NullableAttribute"
        Assert.Equal("Shadow5144", set.TryResolveName(name)!!.Module!!.Identity.Name)
        let wellKnown = set.WellKnown.TryGet(name)!!
        Assert.True(wellKnown.IsResolved)
        Assert.NotEqual("Shadow5144", wellKnown.Module!!.Identity.Name)
        Assert.True(wellKnown.Module!!.IsExternallyVisible(wellKnown.Handle))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func UnreadableDependencyImage_IsSkippedAndTheRestOfTheSetStands() {
        using let good = CSharpFixture("public class Good5144 {}", assemblyName: "Good5144")
        let broken = Path.Combine(Path.GetDirectoryName(good.AssemblyPath)!!, "Broken5144.dll")
        File.WriteAllBytes(broken, []uint8{1, 2, 3, 4})
        using let resolver = HandleResolver([]string{good.AssemblyPath, broken})
        let set = resolver.ImageSet!!
        Assert.NotNull(set.FindModule("Good5144"))
        Assert.Null(set.FindModule("Broken5144"))
    }

    @Fact
    func TypeReference_ToAnEscapedName_ResolvesToTheDefinition() {
        // The reference keeps the raw metadata name. The set escapes it once, as the definition's name is escaped.
        let escaping = SaveEscapingAssembly()
        let set = ReferenceImageSet(
            ImmutableArray.Create(
                ReferenceImage(File.ReadAllBytes(escaping), escaping, true),
                ReferenceImage(
                    BuildReferencing("Referencing5144", "Escaping5144", "N5144,Ns", "Odd5144+Name", "Nested5144"),
                    nil,
                    true
                ),
                ReferenceImage(BuildReferencing("Nesting5144", "Escaping5144", "", "Out5144+er", "In*ner"), nil, true)
            )
        )
        let plain = set.FindModule("Referencing5144")!!
        let first = set.ResolveTypeReference(plain, MetadataTokens.TypeReferenceHandle(1))
        Assert.True(first.IsResolved, first.FullName)
        Assert.Equal("N5144\\,Ns.Odd5144\\+Name", first.FullName)
        Assert.Equal("Escaping5144", first.Module!!.Identity.Name)
        // The nested name does not exist in the definition: it is missing, with the escaped enclosing name.
        let missing = set.ResolveTypeReference(plain, MetadataTokens.TypeReferenceHandle(2))
        Assert.False(missing.IsResolved)
        Assert.Equal("N5144\\,Ns.Odd5144\\+Name+Nested5144", missing.FullName)
        let nesting = set.FindModule("Nesting5144")!!
        let outer = set.ResolveTypeReference(nesting, MetadataTokens.TypeReferenceHandle(1))
        let inner = set.ResolveTypeReference(nesting, MetadataTokens.TypeReferenceHandle(2))
        Assert.True(outer.IsResolved && inner.IsResolved)
        Assert.Equal("Out5144\\+er+In\\*ner", inner.FullName)
        Assert.Equal("Escaping5144", inner.Module!!.Identity.Name)
    }

    @Fact
    func NestingSeparator_IgnoresAPlusThatBelongsToAName() {
        Assert.Equal(-1, MetadataTypeNameReader.NestingSeparatorIndex("N.Plain"))
        Assert.Equal(-1, MetadataTypeNameReader.NestingSeparatorIndex("N.Odd\\+Name"))
        Assert.Equal(5, MetadataTypeNameReader.NestingSeparatorIndex("Outer+Inner"))
        Assert.Equal(9, MetadataTypeNameReader.NestingSeparatorIndex("Out\\+er+x+y"))
        // An even count of backslashes escapes the backslash, not the plus.
        Assert.Equal(3, MetadataTypeNameReader.NestingSeparatorIndex("A\\\\+B"))
    }

    @Fact
    func SelfScopedTypeReference_EndsAtTheNestingLimit_InTheSetAndInTheComparison() {
        let loop = ReferenceImageSet(
            ImmutableArray.Create(ReferenceImage(BuildSelfScoped("Loop5144Assembly"), nil, true))
        )
        let module = loop.FindModule("Loop5144Assembly")!!
        Assert.False(loop.ResolveTypeReference(module, MetadataTokens.TypeReferenceHandle(1)).IsResolved)
        // The comparison spells the same chain, stops at the same depth and treats it as not comparable.
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let withLoop = ReferenceImageSet(
            resolver.ImageSet!!
                .Modules
                .Select((m MetadataModule) -> ReferenceImage(m.Image, m.Path, m.IsSearched))
                .Append(ReferenceImage(BuildSelfScoped("Loop5144Assembly"), nil, false))
                .ToImmutableArray()
        )
        Assert.Empty(MetadataModelComparison.Compare(resolver, withLoop))
    }

    @Fact
    func DeepTypeReferenceChain_GivesTheSameAnswerInEveryLookupOrder() {
        // 70 nested definitions and 70 references to them. Rows deeper than the nesting limit are malformed.
        // An answer must depend on the row, not on which row was asked first.
        let count = 70
        let target = BuildDeepTarget("DeepTarget5144", count)
        let referencing = BuildDeepReferencing("DeepReferencing5144", "DeepTarget5144", count)
        let forward = ReferenceImageSet(
            ImmutableArray.Create(ReferenceImage(target, nil, true), ReferenceImage(referencing, nil, true))
        )
        let backward = ReferenceImageSet(
            ImmutableArray.Create(ReferenceImage(target, nil, true), ReferenceImage(referencing, nil, true))
        )
        let forwardModule = forward.FindModule("DeepReferencing5144")!!
        let backwardModule = backward.FindModule("DeepReferencing5144")!!
        let resolvedForward = List[string]()
        for var row = 1; row <= count; row++ {
            let answer = forward.ResolveTypeReference(forwardModule, MetadataTokens.TypeReferenceHandle(row))
            resolvedForward.Add(answer.IsResolved.ToString() + " " + answer.FullName)
        }
        // The deepest row first: the old memo cached its ancestors as missing.
        let resolvedBackward = Dictionary[int32, string]()
        for var row = count; row >= 1; row-- {
            let answer = backward.ResolveTypeReference(backwardModule, MetadataTokens.TypeReferenceHandle(row))
            resolvedBackward[row] = answer.IsResolved.ToString() + " " + answer.FullName
        }
        for var row = 1; row <= count; row++ {
            Assert.Equal(resolvedForward[row - 1], resolvedBackward[row])
        }
        Assert.StartsWith("True N.T0", resolvedForward[0])
        Assert.StartsWith("True N.T0+T1", resolvedForward[1])
        Assert.StartsWith("False", resolvedForward[count - 1])
    }

    @Fact
    func NestingLimit_IsOneDecision_ForTheSetAndTheComparison() {
        // Rows 64, 65 and 66 of a chain have 63, 64 and 65 enclosing links. The limit is 64 links.
        let referencing = BuildDeepReferencing("Boundary5144", "BoundaryTarget5144", 70)
        let set = ReferenceImageSet(
            ImmutableArray.Create(
                ReferenceImage(BuildDeepTarget("BoundaryTarget5144", 70), nil, true),
                ReferenceImage(referencing, nil, true)
            )
        )
        let module = set.FindModule("Boundary5144")!!
        for row in[]int32{64, 65, 66} {
            let handle = MetadataTokens.TypeReferenceHandle(row)
            let tooDeep = MetadataTypeNameReader.IsEnclosingChainTooDeep(module.Reader, handle)
            // The set resolves exactly the rows that the shared predicate accepts, and so does the oracle's spelling.
            Assert.Equal(row > 65, tooDeep)
            Assert.Equal(!tooDeep, set.ResolveTypeReference(module, handle).IsResolved)
        }
    }

    @Fact
    func Comparison_AsksTheContext_EvenWhenTheSetLacksTheAssembly() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let good = resolver.ImageSet!!
        // Remove a dependency-only module that some type reference resolves into.
        var removed string? = nil
        for other in good.Modules {
            for handle in other.Reader.TypeReferences {
                let answer = good.ResolveTypeReference(other, handle)
                let target = answer.Module
                if removed == nil && target != nil && !target.IsSearched {
                    removed = target.Identity.Name
                }
            }
        }
        Assert.NotNull(removed)
        let without = ReferenceImageSet(
            good
                .Modules
                .Where((m MetadataModule) -> m.Identity.Name != removed)
                .Select((m MetadataModule) -> ReferenceImage(m.Image, m.Path, m.IsSearched))
                .ToImmutableArray()
        )
        let found = MetadataModelComparison.Compare(resolver, without)
        Assert.Contains(found, (d ModelDisagreement) -> d.Question == "Q1.type-reference")
    }

    @Fact
    func CompareMode_DoesNotChangeALaterBinding_WhenAnInternalShadowGrantsTheConsumer() {
        // The shadow comes first and grants InternalsVisibleTo to the consumer. In `mlc` mode, once the consumer
        // name is set, the shadow wins. Comparison must not cache the public copy before the name is known.
        using let shadow = CSharpFixture(
            "[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"Friend5144\")] namespace System.Runtime.CompilerServices { internal sealed class NullableAttribute : System.Attribute {} }",
            assemblyName: "FriendShadow5144"
        )
        let name = "System.Runtime.CompilerServices.NullableAttribute"
        using let plain = ModeResolver(MetadataModelMode.Mlc, []string{shadow.AssemblyPath})
        plain.CurrentAssemblyName = "Friend5144"
        Assert.True(plain.TryResolveType(name, false, out var expected))
        Assert.Equal("FriendShadow5144", expected.Assembly.GetName().Name)
        using let compared = ModeResolver(MetadataModelMode.Compare, []string{shadow.AssemblyPath})
        Assert.NotNull(compared.ImageSet)
        compared.CurrentAssemblyName = "Friend5144"
        Assert.True(compared.TryResolveType(name, false, out var actual))
        Assert.Equal("FriendShadow5144", actual.Assembly.GetName().Name)
    }

    @Fact
    func ModeSwitch_ParsesNamesAndDefaultsToTheContextModel() {
        Assert.Equal(MetadataModelMode.Mlc, MetadataModel.Parse(nil))
        Assert.Equal(MetadataModelMode.Mlc, MetadataModel.Parse(""))
        Assert.Equal(MetadataModelMode.Mlc, MetadataModel.Parse("mlc"))
        Assert.Equal(MetadataModelMode.Mlc, MetadataModel.Parse("nonsense"))
        Assert.Equal(MetadataModelMode.Handles, MetadataModel.Parse("handles"))
        Assert.Equal(MetadataModelMode.Handles, MetadataModel.Parse(" HANDLES "))
        Assert.Equal(MetadataModelMode.Compare, MetadataModel.Parse("Compare"))
        using let _ = MetadataModel.Override(MetadataModelMode.Compare)
        Assert.Equal(MetadataModelMode.Compare, MetadataModel.Current)
    }

    @Fact
    func Resolver_BuildsTheSetOnlyInTheHandleModes() {
        let paths = []string{typeof(ReferenceResolver).Assembly.Location}
        using let mlc = MetadataModel.Override(MetadataModelMode.Mlc)
        using let plain = ReferenceResolver.WithReferences(paths)
        Assert.Null(plain.ImageSet)
        using let handles = HandleResolver(paths)
        Assert.NotNull(handles.ImageSet)
    }

    @Fact
    func CompareMode_CountsZeroAndWritesTheReportBesideThePhaseJson() {
        let directory = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        let phasePath = Path.Combine(directory, "phases.json")
        using let measurements = CompilationMeasurements.Start("issue5144", phasePath)
        using let compare = MetadataModel.Override(MetadataModelMode.Compare)
        using let resolver = ReferenceResolver.WithReferences([]string{typeof(ReferenceResolver).Assembly.Location})
        Assert.NotNull(resolver.ImageSet)
        Assert.Equal(0, measurements.GetCounter(MetadataModelComparison.CounterName))
        measurements.Dispose()
        // The counter is in the JSON with the value 0, so a reader can tell "compared and equal" from "not compared".
        Assert.Contains("\"metadata.model-disagreements\": 0", File.ReadAllText(phasePath))
        let report = File.ReadAllText(phasePath + ".model-disagreements.txt")
        Assert.StartsWith("metadata.model-disagreements: 0", report)
    }

    @Fact
    func Disagreements_AreCountedAndReported() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let good = resolver.ImageSet!!
        // A set that lost its first module: the counts differ.
        let withoutFirst = ReferenceImageSet(
            good
                .Modules
                .Skip(1)
                .Select((m MetadataModule) -> ReferenceImage(m.Image, m.Path, m.IsSearched))
                .ToImmutableArray()
        )
        let dropped = MetadataModelComparison.Compare(resolver, withoutFirst)
        Assert.Contains(dropped, (d ModelDisagreement) -> d.Question == "Q1.modules")
        // A set whose first two modules swapped: the names of both modules differ.
        let swapped = good.Modules.Select((m MetadataModule) -> ReferenceImage(m.Image, m.Path, m.IsSearched)).ToArray()
        let first = swapped[0]
        swapped[0] = swapped[1]
        swapped[1] = first
        let swappedSet = ReferenceImageSet(swapped.ToImmutableArray())
        let swappedResult = MetadataModelComparison.Compare(resolver, swappedSet)
        Assert.Equal(2, swappedResult.Count((d ModelDisagreement) -> d.Question == "Q1.names"))
        let subjects = swappedResult.Select((d ModelDisagreement) -> d.Subject).ToArray()
        Assert.Equal(
            []string{good.Modules[1].Identity.Name, good.Modules[0].Identity.Name}.OrderBy((n string) -> n),
            subjects.OrderBy((n string) -> n)
        )
        // No set at all is one disagreement.
        Assert.Single(MetadataModelComparison.Compare(resolver, nil))
        // The counter holds the count, and the report names each disagreement.
        let directory = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        let phasePath = Path.Combine(directory, "phases.json")
        using let measurements = CompilationMeasurements.Start("issue5144", phasePath)
        MetadataModelComparison.CompareAndReport(resolver, swappedSet)
        Assert.Equal(2, measurements.GetCounter(MetadataModelComparison.CounterName))
        measurements.Dispose()
        let report = File.ReadAllLines(phasePath + ".model-disagreements.txt")
        Assert.Equal("metadata.model-disagreements: 2", report[0])
        Assert.Equal(3, report.Length)
        Assert.StartsWith("Q1.names\t", report[1])
    }

    shared {
        private func HandleResolver(paths[]string) ReferenceResolver -> ModeResolver(MetadataModelMode.Handles, paths)

        private func ModeResolver(mode MetadataModelMode, paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(mode)
            return ReferenceResolver.WithReferences(paths)
        }

        private func Difference(expected List[string], actual List[string]) string {
            var at = 0
            while at < expected.Count && at < actual.Count && expected[at] == actual[at] {
                at++
            }
            return "counts ${expected.Count} ${actual.Count}; at ${at}: expected ${string.Join(" | ", expected.Skip(at).Take(4))} actual ${string.Join(" | ", actual.Skip(at).Take(4))}"
        }

        private func SaveEscapingAssembly() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let path = Path.Combine(directory, "Escaping5144.dll")
            let builder = PersistedAssemblyBuilder(AssemblyName("Escaping5144"), typeof(object).Assembly)
            let module_ = builder.DefineDynamicModule("Escaping5144")
            module_.DefineType("Plain5144", TypeAttributes.Public | TypeAttributes.Class).CreateType()
            module_.DefineType("Odd5144[Name", TypeAttributes.Public | TypeAttributes.Class).CreateType()
            module_.DefineType("N5144,Ns.Odd5144+Name", TypeAttributes.Public | TypeAttributes.Class).CreateType()
            module_.DefineType("Back5144\\Slash", TypeAttributes.Public | TypeAttributes.Class).CreateType()
            let outer = module_.DefineType("Out5144+er", TypeAttributes.Public | TypeAttributes.Class)
            let inner = outer.DefineNestedType("In*ner", TypeAttributes.NestedPublic | TypeAttributes.Class)
            outer.CreateType()
            inner.CreateType()
            builder.Save(path)
            return path
        }

        // Starts an assembly image that defines no type.
        private func NewMetadata(name string) MetadataBuilder {
            let metadata = MetadataBuilder()
            metadata.AddModule(
                0,
                metadata.GetOrAddString(name + ".dll"),
                metadata.GetOrAddGuid(Guid.NewGuid()),
                GuidHandle(),
                GuidHandle()
            )
            metadata.AddAssembly(
                metadata.GetOrAddString(name),
                Version(1, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                AssemblyHashAlgorithm.None
            )
            metadata.AddTypeDefinition(
                cast[TypeAttributes](0),
                StringHandle(),
                metadata.GetOrAddString("<Module>"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            return metadata
        }

        private func AddAssemblyReference(metadata MetadataBuilder, name string) AssemblyReferenceHandle -> metadata
            .AddAssemblyReference(
            metadata.GetOrAddString(name),
            Version(1, 0, 0, 0),
            StringHandle(),
            BlobHandle(),
            cast[AssemblyFlags](0),
            BlobHandle()
        )

        private func Serialize(metadata MetadataBuilder)[]uint8 {
            let image = BlobBuilder()
            ManagedPEBuilder(
                PEHeaderBuilder.CreateLibraryHeader(),
                MetadataRootBuilder(metadata),
                BlobBuilder()
            ).Serialize(image)
            return image.ToArray()
        }

        // Writes an assembly image that defines nothing and forwards one type to another assembly.
        private func BuildForwarder(name string, target string, namespaceName string, typeName string)[]uint8 {
            let metadata = NewMetadata(name)
            metadata.AddExportedType(
                cast[TypeAttributes](0x00200000),
                metadata.GetOrAddString(namespaceName),
                metadata.GetOrAddString(typeName),
                AddAssemblyReference(metadata, target),
                0
            )
            return Serialize(metadata)
        }

        // Writes an assembly image with a reference to a type of another assembly and one to a type nested in it.
        private func BuildReferencing(
            name string,
            target string,
            namespaceName string,
            outerName string,
            nestedName string
        )[]uint8 {
            let metadata = NewMetadata(name)
            let outer = metadata.AddTypeReference(
                AddAssemblyReference(metadata, target),
                metadata.GetOrAddString(namespaceName),
                metadata.GetOrAddString(outerName)
            )
            metadata.AddTypeReference(outer, StringHandle(), metadata.GetOrAddString(nestedName))
            return Serialize(metadata)
        }

        // Writes an assembly that defines N.T0 and the types T1 to T(count-1), each nested in the one before.
        private func BuildDeepTarget(name string, count int32)[]uint8 {
            let metadata = NewMetadata(name)
            for var i = 0; i < count; i++ {
                metadata.AddTypeDefinition(
                    if i == 0 {
                        TypeAttributes.Public
                    } else {
                        TypeAttributes.NestedPublic
                    },
                    if i == 0 {
                        metadata.GetOrAddString("N")
                    } else {
                        StringHandle()
                    },
                    metadata.GetOrAddString("T" + i.ToString()),
                    EntityHandle(),
                    MetadataTokens.FieldDefinitionHandle(1),
                    MetadataTokens.MethodDefinitionHandle(1)
                )
                if i > 0 {
                    // Row 1 is `<Module>`, so T(i) is row i + 2 and its enclosing type is row i + 1.
                    metadata.AddNestedType(
                        MetadataTokens.TypeDefinitionHandle(i + 2),
                        MetadataTokens.TypeDefinitionHandle(i + 1)
                    )
                }
            }
            return Serialize(metadata)
        }

        // Writes an assembly with a chain of type references: row 1 names N.T0, row k names T(k-1) nested in row k-1.
        private func BuildDeepReferencing(name string, target string, count int32)[]uint8 {
            let metadata = NewMetadata(name)
            var enclosing EntityHandle = AddAssemblyReference(metadata, target)
            for var i = 0; i < count; i++ {
                enclosing = metadata.AddTypeReference(
                    enclosing,
                    if i == 0 {
                        metadata.GetOrAddString("N")
                    } else {
                        StringHandle()
                    },
                    metadata.GetOrAddString("T" + i.ToString())
                )
            }
            return Serialize(metadata)
        }

        // Writes an assembly image whose only type reference names itself as its resolution scope.
        private func BuildSelfScoped(name string)[]uint8 {
            let metadata = NewMetadata(name)
            metadata.AddTypeReference(
                MetadataTokens.TypeReferenceHandle(1),
                StringHandle(),
                metadata.GetOrAddString("Loop5144")
            )
            return Serialize(metadata)
        }

        private func ForwardedTypes(assembly Assembly)[]Type? {
            try {
                return assembly.GetForwardedTypes()
            } catch (ex ReflectionTypeLoadException) {
                return ex.Types
            }
        }

        private func ReflectionNames(assembly Assembly) List[string] {
            var defined[]Type?
            try {
                defined = assembly.GetTypes()
            } catch (ex ReflectionTypeLoadException) {
                defined = ex.Types
            }
            let names = List[string]()
            for t in defined {
                if t?.FullName is {} name {
                    names.Add(name)
                }
            }
            for t in ForwardedTypes(assembly) {
                if t?.FullName is {} name {
                    names.Add(name)
                }
            }
            return names
        }
    }
}
