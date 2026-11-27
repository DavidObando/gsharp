package GSharp.Core.CodeAnalysis

import System

/// Validates names shared by scoped symbols and compilation options.
shared class ConditionalSymbols {
    /// Tests a case-sensitive G# symbol name without an escape prefix.
    /// @param name The proposed symbol name.
    /// @returns Whether the name is a non-boolean identifier.
    func IsValidName(name string) bool {
        if string.IsNullOrEmpty(name) || name is "true" or "false" {
            return false
        }
        if !char.IsLetter(name[0]) && name[0] != '_' {
            return false
        }
        for var i = 1; i < name.Length; i++ {
            if !char.IsLetterOrDigit(name[i]) && name[i] != '_' {
                return false
            }
        }
        return true
    }
}
