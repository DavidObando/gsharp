package Oahu.Decrypt.Mpeg4.Util

import System.Security.Cryptography

class Crypto {
    shared {
        func DecryptInPlace(key []uint8, iv []uint8, encryptedBlocks []uint8) {
            using let aes = Aes.Create()
            aes.Mode = CipherMode.CBC
            aes.Padding = PaddingMode.None
            using let cbcDecryptor = aes.CreateDecryptor(key, iv)
            cbcDecryptor.TransformBlock(encryptedBlocks, 0, encryptedBlocks.Length & 0x7ffffff0, encryptedBlocks, 0)
        }

        func Sha1(blocks ...([]uint8, int32, int32)) []uint8 {
            using let sha = SHA1.Create()
            var i = 0
            for ; i < blocks.Length - 1; i++ {
                sha.TransformBlock(blocks[i].Item1, blocks[i].Item2, blocks[i].Item3, nil, 0)
            }
            sha.TransformFinalBlock(blocks[i].Item1, blocks[i].Item2, blocks[i].Item3)
            return sha.Hash!!
        }
    }
}
