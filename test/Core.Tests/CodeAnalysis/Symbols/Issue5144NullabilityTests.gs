// <copyright file="Issue5144NullabilityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Linq
import Xunit

/// ADR-0209 PR 2c-ii-b1 (#5144): nullability of the positions that have no inner position, read from the attribute blobs
/// through the funnel. The expected marks are written out, not computed by the product: `?` is a stated nullable, `!` a
/// platform type, empty a non-null or a value type, `~` a position that a later stage reads.
open class Issue5144NullabilityTests {
    @Fact
    func TheMarksOfAnAnnotatedAssembly_AreTheDeclaredOnes() {
        using let fixture = CSharpFixture(
            string.Join(
                "\n",
                []string{
                    "#nullable enable",
                    "namespace N5144N {",
                    "    public class Annotated {",
                    "        public string NotNull = \"\";",
                    "        public string? Maybe;",
                    "        public int Plain;",
                    "        public int? Boxed;",
                    "        public System.Collections.Generic.List<string> Inner = null!;",
                    "        public string Echo(string a, string? b, ref string c) { return a; }",
                    "        public string? Mixed(string? a, string b, string? c) { return a; }",
                    "    }",
                    "    public class Generic<T> {",
                    "        public T Value = default!;",
                    "        public T? Maybe;",
                    "    }",
                    "}"
                }
            ),
            assemblyName: "Nullable5144A"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Nullable5144A")!!
        let annotated = TypeOf(module, "N5144N.Annotated")
        Assert.Equal("", FieldMark(annotated, "NotNull"))
        Assert.Equal("?", FieldMark(annotated, "Maybe"))
        Assert.Equal("", FieldMark(annotated, "Plain"))
        // Nullable<int> is a stated nullable by structure.
        Assert.Equal("?", FieldMark(annotated, "Boxed"))
        // A position with type arguments is read by a later stage.
        Assert.Equal("~", FieldMark(annotated, "Inner"))
        Assert.Equal("r;;?;", MethodMarks(annotated, "Echo"))
        // The method's own context (2) holds for the positions that state nothing, and [Nullable(1)] wins on `b`.
        Assert.Equal("r?;?;;?", MethodMarks(annotated, "Mixed"))
        let generic = TypeOf(module, "N5144N.Generic`1")
        Assert.Equal("", FieldMark(generic, "Value"))
        Assert.Equal("?", FieldMark(generic, "Maybe"))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func AnObliviousAssembly_IsPlatformTypesExceptForValueTypes() {
        using let fixture = CSharpFixture(
            string.Join(
                "\n",
                []string{
                    "#nullable disable",
                    "namespace N5144O {",
                    "    public enum Color { Red }",
                    "    public struct Point { public int X; }",
                    "    public class Oblivious {",
                    "        public string Text;",
                    "        public Color Tint;",
                    "        public Point Where;",
                    "        public int Count;",
                    "        public object Echo(string a, int b) { return a; }",
                    "        public void Fill(ref string s, out Point p) { p = default; }",
                    "    }",
                    "}"
                }
            ),
            assemblyName: "Nullable5144O"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let oblivious = TypeOf(set.FindModule("Nullable5144O")!!, "N5144O.Oblivious")
        Assert.Equal("!", FieldMark(oblivious, "Text"))
        // A value type never becomes a platform type, whichever assembly it comes from.
        Assert.Equal("", FieldMark(oblivious, "Tint"))
        Assert.Equal("", FieldMark(oblivious, "Where"))
        Assert.Equal("", FieldMark(oblivious, "Count"))
        Assert.Equal("r!;!;", MethodMarks(oblivious, "Echo"))
        // A by-ref position has the mark of its referent.
        Assert.Equal("r;!;", MethodMarks(oblivious, "Fill"))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func TheDeclaredState_IsReadFromTheOwnBytesFirstThenTheContextChain() {
        using let fixture = CSharpFixture(
            string.Join(
                "\n",
                []string{
                    "#nullable enable",
                    "namespace N5144C {",
                    "    public class Outer {",
                    "        public string OuterField = \"\";",
                    "        public class Inner {",
                    "            public string? InnerField;",
                    "            public string Plain = \"\";",
                    "        }",
                    "    }",
                    "}"
                }
            ),
            assemblyName: "Nullable5144C"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Nullable5144C")!!
        let inner = TypeOf(module, "N5144C.Outer+Inner")
        Assert.Equal("?", FieldMark(inner, "InnerField"))
        Assert.Equal("", FieldMark(inner, "Plain"))
        Assert.Equal("", FieldMark(TypeOf(module, "N5144C.Outer"), "OuterField"))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func APositionWithNoBytesAtAll_IsOblivious_AndAnExplicitBlobIsRead() {
        // An assembly with no nullable metadata reads as oblivious; one with `[Nullable(2)]` and `[NullableContext(1)]`
        // on the same type reads each position by its own bytes first.
        using let fixture = CSharpFixture(
            string.Join(
                "\n",
                []string{
                    "#nullable enable",
                    "namespace N5144B { public class Both { public string? A; public string B = \"\"; public string? C; } }"
                }
            ),
            assemblyName: "Nullable5144B"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let both = TypeOf(resolver.ImageSet!!.FindModule("Nullable5144B")!!, "N5144B.Both")
        Assert.Equal("?", FieldMark(both, "A"))
        Assert.Equal("", FieldMark(both, "B"))
        Assert.Equal("?", FieldMark(both, "C"))
        let state = both.Fields.First((f MetadataFieldSymbol) -> f.Name == "A").NullableFieldType.State
        Assert.Equal(ClrNullabilityState.Annotated, state)
        Assert.Equal(
            ClrNullabilityState.NotAnnotated,
            both.Fields.First((f MetadataFieldSymbol) -> f.Name == "B").NullableFieldType.State
        )
    }

    @Fact
    func TheContextOfOnlyTheOuterType_ReachesAMemberOfANestedType() {
        // Every member of every type is non-null, so the compiler states the context once, on the outermost type.
        using let fixture = CSharpFixture(
            string.Join(
                "\n",
                []string{
                    "#nullable enable",
                    "namespace N5144D {",
                    "    public class Top {",
                    "        public string TopField = \"\";",
                    "        public class Middle {",
                    "            public string MiddleField = \"\";",
                    "            public class Deep { public string DeepField = \"\"; public string Echo(string a) { return a; } }",
                    "        }",
                    "    }",
                    "}"
                }
            ),
            assemblyName: "Nullable5144D"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let deep = TypeOf(set.FindModule("Nullable5144D")!!, "N5144D.Top+Middle+Deep")
        Assert.Equal("", FieldMark(deep, "DeepField"))
        Assert.Equal("r;", MethodMarks(deep, "Echo"))
        Assert.Empty(MetadataModelComparison.CompareFixture(resolver, set))
    }

    @Fact
    func AnUnreadableOracle_HidesOnlyTheNullabilityOfTheLine() {
        let unread = "method|1|Echo|150|0///this:False/False/vararg:False/n:n/a|System.String(a:0:System.String)"
        let read = "method|1|Echo|150|0///this:False/False/vararg:False/n:r;?|System.String(a:0:System.String)"
        Assert.True(MetadataMemberComparison.SameWhereTheOracleCannotRead(unread, read))
        // A different name, signature or row still disagrees.
        Assert.False(MetadataMemberComparison.SameWhereTheOracleCannotRead(unread, read.Replace("Echo", "Other")))
        Assert.False(MetadataMemberComparison.SameWhereTheOracleCannotRead(unread, read.Replace("a:0:", "b:0:")))
        // A readable oracle is never excused, and the symbol side saying `n/a` does not excuse a readable oracle.
        Assert.False(MetadataMemberComparison.SameWhereTheOracleCannotRead(read, read.Replace("r;?", "r;")))
        Assert.False(MetadataMemberComparison.SameWhereTheOracleCannotRead(read, unread))
        // A field's whole shape is its nullability.
        Assert.True(
            MetadataMemberComparison.SameWhereTheOracleCannotRead(
                "field|2|F|6|n:n/a|System.String",
                "field|2|F|6|n:?|System.String"
            )
        )
        Assert.False(
            MetadataMemberComparison.SameWhereTheOracleCannotRead(
                "field|2|F|6|n:n/a|System.String",
                "field|2|F|6|n:?|System.Int32"
            )
        )
    }

    shared {
        private func HandleResolver(paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(MetadataModelMode.Handles)
            return ReferenceResolver.WithReferences(paths)
        }

        private func TypeOf(module MetadataModule, name string) MetadataTypeSymbol {
            module.TryGetDefinition(name, out var handle)
            return module.GetTypeSymbol(handle)
        }

        private func FieldMark(type MetadataTypeSymbol, name string) string {
            let position = type.Fields.First((f MetadataFieldSymbol) -> f.Name == name).NullableFieldType
            return MetadataNullability.Mark(position.Type, position.IsDeferred)
        }

        private func MethodMarks(type MetadataTypeSymbol, name string) string {
            let signature = type.Methods.First((m MetadataMethodSymbol) -> m.Name == name).NullableSignature
            return "r" + MetadataNullability.Mark(signature.Return.Type, signature.Return.IsDeferred) + string.Concat(
                signature.Parameters.Select(
                    (p MetadataNullablePosition) -> ";" + MetadataNullability.Mark(p.Type, p.IsDeferred)
                )
            )
        }
    }
}
