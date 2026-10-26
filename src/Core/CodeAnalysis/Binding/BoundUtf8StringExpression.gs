package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

internal class BoundUtf8StringExpression : BoundExpression {
    init(
        syntax SyntaxNode,
        bytes ImmutableArray[uint8],
        type TypeSymbol,
        createSpan MethodInfo,
        slice MethodInfo
    ) : base(syntax) {
        Bytes = bytes
        Type = type
        CreateSpan = createSpan
        Slice = slice
    }

    override prop Kind BoundNodeKind -> BoundNodeKind.Utf8StringExpression
    override prop Type TypeSymbol {
        get;
    }
    prop Bytes ImmutableArray[uint8] {
        get;
    }
    prop CreateSpan MethodInfo {
        get;
    }
    prop Slice MethodInfo {
        get;
    }
}
