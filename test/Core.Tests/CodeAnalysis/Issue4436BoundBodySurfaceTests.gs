// <copyright file="Issue4436BoundBodySurfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4436 (ADR-0169): the bound-body surface follows Roslyn's operation
/// tree, not the compiler walker, where the two differ.
open class Issue4436BoundBodySurfaceTests {
    @Fact
    func Descendants_EnterFunctionLiteralBodies() {
        // The walker keeps a function literal opaque; Roslyn's operation block
        // contains the lambda's body, so both calls to Add are descendants.
        let kinds = OuterDescendants(Run(Source, GeneratedCodeAnalysisFlags.None))
        Assert.Equal(2, kinds.Count((kind BoundNodeKind) -> kind == BoundNodeKind.CallExpression))
    }

    @Fact
    func ChildNodes_OfAFunctionLiteral_IsItsBody_AndNotItsParents() {
        // The literal lists its body; the declaration holding the literal
        // lists only the literal, never the body as a sibling.
        let probe = Run(Source, GeneratedCodeAnalysisFlags.None)
        let literal = probe
            .Bodies["Outer"]
            .SelectMany(
            func (b BoundNode) IEnumerable[BoundNode] {
                return b.Descendants()
            }
        )
            .OfType[BoundFunctionLiteralExpression]()
            .Single()
        let holder = probe
            .Bodies["Outer"]
            .SelectMany(
            func (b BoundNode) IEnumerable[BoundNode] {
                return b.Descendants()
            }
        )
            .Single((n BoundNode) -> n.ChildNodes.Contains(literal))
        Assert.Equal([]BoundNode{literal.Body}, literal.ChildNodes)
        Assert.DoesNotContain(literal.Body, holder.ChildNodes)
    }

    @Fact
    func Descendants_IsLazy_AndMatchesARecursiveChildWalk() {
        let Recursive = func (node BoundNode) IEnumerable[BoundNode] {
            return node.ChildNodes.SelectMany(
                func (child BoundNode) IEnumerable[BoundNode] {
                    return []BoundNode{child}.Concat(Recursive(child))
                }
            )
        }
        let probe = Run(Source, GeneratedCodeAnalysisFlags.None)
        let body = probe.Bodies["Outer"].Single()
        Assert.Equal(Recursive(body), body.Descendants())
        Assert.Same(body.ChildNodes[0], body.Descendants().First())
    }

    @Fact
    func ChildNodes_OfAnAssignment_AreTargetThenValue() {
        let probe = Run(Source, GeneratedCodeAnalysisFlags.None)
        let assignment = probe
            .Bodies["Outer"]
            .SelectMany(
            func (b BoundNode) IEnumerable[BoundNode] {
                return b.Descendants()
            }
        )
            .OfType[BoundAssignmentExpression]()
            .Single()
        Assert.Equal(
            []BoundNodeKind{BoundNodeKind.VariableExpression, BoundNodeKind.CallExpression},
            assignment.ChildNodes.Select((n BoundNode) -> n.Kind)
        )
        Assert.Same(assignment.Target, assignment.ChildNodes[0])
    }

    @Fact
    func ChildNodes_OfAPlainTypeTest_AreTheOperandOnly() {
        let probe = Run(Source, GeneratedCodeAnalysisFlags.None)
        let test = probe
            .Bodies["Outer"]
            .SelectMany(
            func (b BoundNode) IEnumerable[BoundNode] {
                return b.Descendants()
            }
        )
            .OfType[BoundIsExpression]()
            .Single()
        Assert.Equal([]BoundNodeKind{BoundNodeKind.VariableExpression}, test.ChildNodes.Select((n BoundNode) -> n.Kind))
        Assert.DoesNotContain(OuterDescendants(probe), (kind BoundNodeKind) -> kind == BoundNodeKind.TypePattern)
    }

    @Fact
    func BoundBodyAction_SkipsSynthesizedAccessorsOfAGeneratedTree() {
        // A generated property's accessors have no declaration; their bodies
        // still come from the generated tree.
        let skipping = RunFile(Source, "app.g.gs", GeneratedCodeAnalysisFlags.None)
        Assert.True(
            skipping.Bodies.Count == 0,
            string.Join(",", skipping.Owners.Select((o FunctionSymbol) -> o.Name + "/" + o.MethodKind.ToString()))
        )
        let analyzing = RunFile(Source, "app.g.gs", GeneratedCodeAnalysisFlags.Analyze)
        Assert.Contains(
            analyzing.Owners,
            (owner FunctionSymbol) -> (owner.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet)
        )
    }

    @Fact
    func BoundBodyAction_RunsOnFieldInitializers_OwnedByTheField() {
        // Roslyn runs operation-block actions on field-initializer blocks.
        // G# keeps initializers outside every function body, the
        // constructor's included, so they are dispatched on their own.
        const source = `package App

func Add(left int32, right int32) int32 {
    return left + right
}

class Holder {
    var count int32 = Add(5, 6)
    shared {
        let Seed int32 = Add(7, 8)
    }
    init() {
    }
}
`
        let probe = Run(source, GeneratedCodeAnalysisFlags.None)
        Assert.Equal([]string{"Seed", "count"}, probe.FieldOwners.OrderBy((n string) -> n, StringComparer.Ordinal))
        Assert.All(
            probe.FieldOwners,
            (name string) -> Assert.Contains(
                probe.Bodies[name].SelectMany(
                    func (b BoundNode) IEnumerable[BoundNode] {
                        return b.DescendantsAndSelf()
                    }
                ),
                (n BoundNode) -> n.Kind == BoundNodeKind.CallExpression
            )
        )
    }

    @Fact
    func AnAccessorKeepsThePropertyThatFirstClaimedIt() {
        // A constructed generic property reuses its definition's accessors;
        // repointing them would lose the definition's attributes.
        let getter = FunctionSymbol("get_Value", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let definition = NewProperty()
        let constructed = NewProperty()
        definition.GetterSymbol = getter
        constructed.GetterSymbol = getter
        Assert.Same(definition, getter.AssociatedSymbol)
        definition.GetterSymbol = nil
        Assert.Null(getter.AssociatedSymbol)
    }

    @GSharpDiagnosticAnalyzer
    private class BodyProbe : GSharpDiagnosticAnalyzer {
        private let flags GeneratedCodeAnalysisFlags

        init(flags GeneratedCodeAnalysisFlags) {
            Bodies = Dictionary[string, ImmutableArray[BoundNode]]()
            Owners = List[FunctionSymbol]()
            FieldOwners = List[string]()
            this.flags = flags
        }

        prop Bodies Dictionary[string, ImmutableArray[BoundNode]] {
            get;
        }

        prop Owners List[FunctionSymbol] {
            get;
        }

        prop FieldOwners List[string] {
            get;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Issue4436BoundBodySurfaceTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.ConfigureGeneratedCodeAnalysis(flags)
            context.RegisterBoundBodyAction(
                (ctx BoundBodyAnalysisContext) -> {
                    if ctx.OwningFunction is {} function {
                        Owners.Add(function)
                    } else {
                        FieldOwners.Add(ctx.OwningSymbol.Name)
                    }
                    Bodies[ctx.OwningSymbol.Name] = ctx.Bodies
                }
            )
        }
    }

    shared {
        private const Source string = `package App

class Box {
    prop Value int32 { get { return 1 } }
}

func Add(left int32, right int32) int32 {
    return left + right
}

func Outer() int32 {
    var total int32 = 0
    total = Add(1, 2)
    let f = func() int32 {
        return Add(3, 4)
    }
    let o object = total
    let b = o is int32
    return f()
}
`

        private let ProbeRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE4436",
            "Probe",
            "Probe '{0}'.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )

        private func NewProperty() PropertySymbol -> PropertySymbol(
            "Value",
            TypeSymbol.Int32,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false
        )

        private func OuterDescendants(probe BodyProbe) List[BoundNodeKind] -> probe
            .Bodies["Outer"]
            .SelectMany(
            func (b BoundNode) IEnumerable[BoundNode] {
                return b.Descendants()
            }
        )
            .Select((n BoundNode) -> n.Kind)
            .ToList()

        private func Run(source string, flags GeneratedCodeAnalysisFlags) BodyProbe -> RunFile(source, "app.gs", flags)

        private func RunFile(source string, fileName string, flags GeneratedCodeAnalysisFlags) BodyProbe {
            let probe = BodyProbe(flags)
            let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create[GSharpDiagnosticAnalyzer](probe))
            return probe
        }
    }
}
