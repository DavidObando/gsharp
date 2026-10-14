// <copyright file="Issue3466LateSignatureTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Signatures

import Models
import System.Collections.Generic
import System.Text

delegate Handler(value Models.TextStringBuilder) Models.TextStringBuilder;

delegate ActionHandler(value Models.TextStringBuilder);

shared class OptionalSignatureMethod {
    func Read(first StringBuilder? = nil, second Models.TextStringBuilder? = nil, values ...List[int32]) int32 -> (
        first?.Length ?? 1
    ) +
        (
        if second == nil {
            2
        } else {
            0
        }
    ) +
        values.Count
}

class OptionalSignatureConstructor {
    init(first StringBuilder? = nil, second Models.TextStringBuilder? = nil) {
        this.Value = (first?.Length ?? 1) +
            (
            if second == nil {
                2
            } else {
                0
            }
        )
    }

    prop Value int32 {
        get;
    }

    prop Marker int32
}

class TargetTypedDefaults {
    prop Values[]Models.TextStringBuilder

    prop this[index int32]Models.TextStringBuilder? {
        get -> this.Value!!
        set -> this.Value = value
    }

    prop Value Models.TextStringBuilder?
}
