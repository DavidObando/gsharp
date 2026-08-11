// <copyright file="Issue3081CompositeLiteralCases.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace GSharp.Tests;

internal static class Issue3081CompositeLiteralCases
{
    public const string Controls = """
        package Issue3081Controls
        import System

        open class Base[T] {
            var inherited int32
            var shadowed int32
            prop inheritedProperty int32 { get; set; }
        }

        class Derived[T] : Base[T] {
            var own int32
            var shadowed int32
        }

        struct Value[T] {
            var own int32
        }

        func RunControls() {
            let localValue = Value[int32]{ own: 555 }
            Console.WriteLine(localValue.own)
            let localOwn = Derived[int32]{ own: 566 }
            Console.WriteLine(localOwn.own)
            let localShadowed = Derived[int32]{ shadowed: 577 }
            Console.WriteLine(localShadowed.shadowed)
        }

        let own = Derived[string]{ own: 511 }
        Console.WriteLine(own.own)
        let shadowed = Derived[string]{ shadowed: 522 }
        Console.WriteLine(shadowed.shadowed)
        let value = Value[string]{ own: 533 }
        Console.WriteLine(value.own)
        let property = Derived[string]{ inheritedProperty: 544 }
        Console.WriteLine(property.inheritedProperty)
        RunControls()
        """;

    public static readonly string ControlsOutput =
        $"511{Environment.NewLine}522{Environment.NewLine}533{Environment.NewLine}544{Environment.NewLine}555{Environment.NewLine}566{Environment.NewLine}577{Environment.NewLine}";

    public const string ObjectInitializer = """
        package Issue3081ObjectInitializer
        import System

        open class Base[T] {
            var inherited int32
        }

        class Derived[T] : Base[T] {
        }

        let value = Derived[string]() { inherited = 611 }
        Console.WriteLine(value.inherited)
        """;

    public static readonly string ObjectInitializerOutput = $"611{Environment.NewLine}";

    public const string Lowering = """
        package Issue3081Lowering
        import System

        open class Base {
            var inherited int32
        }

        class Derived[T] : Base {
            prop source int32 { get; set; }

            func Build() Derived[T] {
                return Derived[T]{ inherited: source }
            }
        }

        let owner = Derived[string]() { source = 711 }
        Console.WriteLine(owner.Build().inherited)
        """;

    public static readonly string LoweringOutput = $"711{Environment.NewLine}";

    public const string AsyncSpill = """
        package Issue3081AsyncSpill
        import System
        import System.Threading.Tasks

        open class Base {
            var inherited int32
        }

        class Derived[T] : Base {
        }

        async func Build() Derived[string] {
            return Derived[string]{ inherited: await Task.FromResult(811) }
        }

        let value = Build().Result
        Console.WriteLine(value.inherited)
        """;

    public static readonly string AsyncSpillOutput = $"811{Environment.NewLine}";

    public static string BuildMatrixSource(bool inFunction)
    {
        var body = """
            let forwardedOwn = Forwarded[string]{ own: OFFSET11 }
            Console.WriteLine(forwardedOwn.own)
            let forwardedShadowed = Forwarded[string]{ shadowed: OFFSET12 }
            Console.WriteLine(forwardedShadowed.shadowed)
            let forwardedInherited = Forwarded[string]{ inherited: OFFSET13 }
            Console.WriteLine(forwardedInherited.inherited)

            let closedOwn = Closed[int32]{ own: OFFSET21 }
            Console.WriteLine(closedOwn.own)
            let closedShadowed = Closed[int32]{ shadowed: OFFSET22 }
            Console.WriteLine(closedShadowed.shadowed)
            let closedInherited = Closed[int32]{ inherited: OFFSET23 }
            Console.WriteLine(closedInherited.inherited)

            let plainOwn = Plain[string]{ own: OFFSET31 }
            Console.WriteLine(plainOwn.own)
            let plainShadowed = Plain[string]{ shadowed: OFFSET32 }
            Console.WriteLine(plainShadowed.shadowed)
            let plainInherited = Plain[string]{ inherited: OFFSET33 }
            Console.WriteLine(plainInherited.inherited)
            """;
        var offset = inFunction ? 200 : 100;
        for (var tens = 1; tens <= 3; tens++)
        {
            for (var ones = 1; ones <= 3; ones++)
            {
                body = body.Replace(
                    $"OFFSET{tens}{ones}",
                    (offset + (tens * 10) + ones).ToString(System.Globalization.CultureInfo.InvariantCulture),
                    StringComparison.Ordinal);
            }
        }

        if (inFunction)
        {
            body = "func RunMatrix() {\n" + Indent(body) + "}\n\nRunMatrix()\n";
        }

        return """
            package Issue3081Matrix
            import System

            open class ForwardBase[T] {
                var inherited int32
                var shadowed int32
            }

            class Forwarded[T] : ForwardBase[T] {
                var own int32
                var shadowed int32
            }

            open class ClosedBase[T] {
                var inherited int32
                var shadowed int32
            }

            class Closed[T] : ClosedBase[string] {
                var own int32
                var shadowed int32
            }

            open class PlainBase {
                var inherited int32
                var shadowed int32
            }

            class Plain[T] : PlainBase {
                var own int32
                var shadowed int32
            }

            """ + body;
    }

    public static string BuildMatrixOutput(int offset)
    {
        using var writer = new StringWriter();
        for (var tens = 1; tens <= 3; tens++)
        {
            for (var ones = 1; ones <= 3; ones++)
            {
                writer.WriteLine(offset + (tens * 10) + ones);
            }
        }

        return writer.ToString().ReplaceLineEndings(Environment.NewLine);
    }

    private static string Indent(string text) => "    " + text.Replace("\n", "\n    ", StringComparison.Ordinal);
}
