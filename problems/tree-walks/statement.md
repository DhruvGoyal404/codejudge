# Tree Walks

A gardener records a binary tree of labelled nodes in a single array, slot by slot, the
way it would be stored in a heap: slot `1` is the root, and the children of slot `i` are
slots `2i` (left) and `2i + 1` (right). A slot holding `0` is empty, and so is every slot
past the end of the array. A node's children are absent if their slots are empty. The
root slot is never empty, and every non-empty slot other than the root has a non-empty
parent.

Print the labels in preorder (node, left subtree, right subtree), inorder (left subtree,
node, right subtree) and postorder (left subtree, right subtree, node).

## Input
The first line contains `n` (1 <= n <= 100 000), the length of the array.
The second line contains `n` integers `a_1 ... a_n` (0 <= a_i <= 10^6): `a_i` is the label in
slot `i`, or `0` if the slot is empty.

## Output
Print three lines: the preorder, inorder and postorder walks, labels separated by spaces.
