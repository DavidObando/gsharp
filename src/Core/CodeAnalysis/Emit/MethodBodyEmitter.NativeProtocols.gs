// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Linq
import System.Reflection.Metadata

internal partial class MethodBodyEmitter {
    private func EmitNativeProtocolValidation(type TypeSymbol) {
        if NativeProtocolOperations.GetProtocol(type) is not{} protocol {
            return
        }
        if !this.outer.emitCtx.Program.NativeProtocolOperations.TryGetValue(protocol, out var operations) {
            throw InvalidOperationException("Native protocol read has no typed validation plan")
        }
        let method = if type is NullableTypeSymbol {
            operations.Validate
        } else {
            operations.Present
        }
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(this.outer.cache.MethodHandles[method])
    }

    internal func EmitNativeProtocolParameterValidation() {
        if this.SuppressNativeProtocolValidation {
            return
        }
        for parameter in this.parameters.OrderBy(
            (item System.Collections.Generic.KeyValuePair[ParameterSymbol, int32]) -> item.Value
        ) {
            if NativeProtocolOperations.GetProtocol(parameter.Key.Type) == nil {
                continue
            }
            if parameter.Key.RefKind != RefKind.None {
                throw InvalidOperationException(
                    "By-reference native protocol parameters require an admitted boundary contract"
                )
            }
            this.il.LoadArgument(parameter.Value)
            this.EmitNativeProtocolValidation(parameter.Key.Type)
            this.il.OpCode(ILOpCode.Pop)
        }
    }
}
